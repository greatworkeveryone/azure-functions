/// <reference types="jest" />
import type { Connection } from "tedious";
import {
  buildEmail,
  eventForRetry,
  isRetryDue,
  notifyPreviousLevel,
  notifyRaiserResolved,
  notifyTargets,
  retryDelayMs,
  targetAddresses,
  targetUsers,
  type NotifyOptions,
} from "./notifier";
import { MAX_NOTIFICATION_ATTEMPTS } from "./config";
import type { DirectoryUser, EscalationRow } from "./types";
import { getAdapter } from "./adapters";

jest.mock("./store", () => ({
  listActiveUsers: jest.fn(),
  recordNotification: jest.fn().mockResolvedValue(undefined),
}));
const store = require("./store") as { listActiveUsers: jest.Mock; recordNotification: jest.Mock };
jest.mock("../test-data", () => ({ ...jest.requireActual("../test-data"), readIsTest: jest.fn().mockResolvedValue(false) }));
const testData = require("../test-data") as { readIsTest: jest.Mock };
// The job adapter's onChange runs after a send (J6); its UPDATE goes nowhere here.
jest.mock("../db", () => ({ executeQuery: jest.fn().mockResolvedValue([]) }));

const conn = {} as Connection;
const NOW = new Date("2026-10-13T01:00:00Z");

const user = (userId: number, name: string, role: string, email: string | null = `${name.toLowerCase()}@example.com`): DirectoryUser => ({ email, name, role, userId });
const ADAM = user(1, "Adam", "facilities_manager");
const BEA = user(2, "Bea", "facilities_manager");
const DEE = user(5, "Dee", "director");
const ELI = user(6, "Eli", "director");
const ADA = user(7, "Ada", "admin");
const FAY = user(8, "Fay", "facilities");
const CAM = user(3, "Cam", "accounts_manager");
const USERS = [ADAM, BEA, CAM, DEE, ELI, ADA, FAY];

const ENV = {
  APP_BASE_URL: "https://floorplan.example/",
  GRAPH_CLIENT_ID: "id",
  GRAPH_CLIENT_SECRET: "secret",
  GRAPH_SENDER_EMAIL: "floorplan@example.com",
  GRAPH_TENANT_ID: "tenant",
} as NodeJS.ProcessEnv;

function row(overrides: Partial<EscalationRow> = {}): EscalationRow {
  return {
    acknowledgedAt: null,
    acknowledgedByName: null,
    acknowledgedByUserId: null,
    buildingId: 5,
    context: null,
    createdAt: new Date("2026-10-13T00:00:00Z"),
    dueAt: new Date("2026-10-13T08:00:00Z"),
    escalationId: 42,
    kind: "attention",
    lastFollowUpAt: null,
    lastNotificationAttemptAt: null,
    lastNotificationError: null,
    lastNotifiedAt: null,
    level: 1,
    noIndependentTarget: false,
    note: "Tenant is chasing",
    notificationAttempts: 0,
    notificationState: "pending",
    parentEscalationId: null,
    policyKey: "job.manual",
    raisedByKind: "user",
    raisedByName: "Fay Staff",
    raisedByUserId: 8,
    reason: "needs_decision",
    resolutionCode: null,
    resolutionNote: null,
    resolvedAt: null,
    resolvedByName: null,
    resolvedByUserId: null,
    rowVersion: "AAAAAAAAB9A=",
    status: "open",
    subjectId: "12",
    subjectType: "job",
    summary: "Job #12 · Leaking roof — Escalated by Fay Staff: Needs a decision",
    targetRole: "facilities_manager",
    targetUserId: null,
    updatedAt: new Date("2026-10-13T00:00:00Z"),
    urgent: false,
    ...overrides,
  };
}

function options(over: Partial<NotifyOptions> = {}): NotifyOptions & { sendMail: jest.Mock; sleep: jest.Mock } {
  return {
    env: ENV,
    now: () => NOW,
    sendMail: jest.fn().mockResolvedValue(undefined),
    sleep: jest.fn().mockResolvedValue(undefined),
    users: USERS,
    ...over,
  } as NotifyOptions & { sendMail: jest.Mock; sleep: jest.Mock };
}

const recorded = () => store.recordNotification.mock.calls.map((c) => ({ attempts: c[3], id: c[1], outcome: c[2] }));

beforeEach(() => {
  jest.clearAllMocks();
  store.recordNotification.mockResolvedValue(undefined);
  delete process.env.DEV_EMAIL_OVERRIDE;
});

afterEach(() => {
  delete process.env.DEV_EMAIL_OVERRIDE;
});

describe("raise: email the targets", () => {
  it("sends one email to the active facilities managers with a link that opens the job", async () => {
    const o = options();

    const outcome = await notifyTargets(conn, row(), "raise", o);

    expect(o.sendMail).toHaveBeenCalledTimes(1);
    const [to, subject, body] = o.sendMail.mock.calls[0];
    expect(to).toEqual(["adam@example.com", "bea@example.com"]);
    expect(subject).toBe("Escalation: Job #12 · Leaking roof — Escalated by Fay Staff: Needs a decision");
    expect(body).toContain("https://floorplan.example/jobs?jobId=12");
    expect(body).toContain("Raised by: Fay Staff");
    expect(body).toContain("Goes to: Facilities manager");
    expect(body).toContain("Reason: Needs a decision");
    expect(body).toContain("Note: Tenant is chasing");
    expect(body).toContain("Respond by: 13/10/2026 17:30 Darwin time");
    expect(outcome).toMatchObject({ attempts: 1, error: null, state: "sent" });
  });

  it("is a pointer only: nothing to approve or decide by reply", async () => {
    const o = options();
    await notifyTargets(conn, row({ kind: "authority" }), "raise", o);
    const body = o.sendMail.mock.calls[0][2] as string;
    expect(body).toMatch(/only points you to Floorplan/i);
    expect(body).not.toMatch(/reply (yes|approve)|click to approve|approve this/i);
  });

  it("records that it was sent, with the time, only after the send succeeded", async () => {
    const o = options();
    await notifyTargets(conn, row(), "raise", o);

    expect(recorded()).toEqual([{ attempts: 1, id: 42, outcome: { attemptedAt: NOW, channel: "email", error: null, notifiedAt: NOW, state: "sent" } }]);
    expect(o.sendMail.mock.invocationCallOrder[0]).toBeLessThan(store.recordNotification.mock.invocationCallOrder[0]);
  });

  it("honours DEV_EMAIL_OVERRIDE: every address becomes the override, once", async () => {
    process.env.DEV_EMAIL_OVERRIDE = "dev@example.com";
    const o = options();

    const outcome = await notifyTargets(conn, row(), "raise", o);

    expect(o.sendMail.mock.calls[0][0]).toEqual(["dev@example.com"]);
    expect(outcome.recipients).toEqual(["dev@example.com"]);
  });

  it("marks URGENT escalations in the subject", async () => {
    const o = options();
    await notifyTargets(conn, row({ urgent: true }), "raise", o);
    expect(o.sendMail.mock.calls[0][1]).toMatch(/^URGENT escalation: /);
  });

  it("tells the people at the new level when it was escalated to them, or is a reminder, or a follow-up", async () => {
    const o = options();
    await notifyTargets(conn, row({ parentEscalationId: 41, targetRole: "director" }), "supersede", o);
    await notifyTargets(conn, row(), "reminder", o);
    await notifyTargets(conn, row(), "follow_up", o);

    expect(o.sendMail.mock.calls.map((c) => c[1].split(":")[0])).toEqual(["Escalated to you", "Reminder", "New email on an escalation"]);
    expect(o.sendMail.mock.calls[0][0]).toEqual(["dee@example.com", "eli@example.com"]);
  });
});

describe("the subject's flag follows a recorded send (J6: EscalatedAt only with a delivery record)", () => {
  const onChange = () => jest.spyOn(getAdapter("job")!, "onChange" as never) as unknown as jest.Mock;

  it("brings the job's EscalatedAt in step once the send is on record, after it is recorded", async () => {
    const spy = onChange();
    await notifyTargets(conn, row(), "raise", options());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toMatchObject({ escalationId: 42, subjectId: "12" });
    expect(store.recordNotification.mock.invocationCallOrder[0]).toBeLessThan(spy.mock.invocationCallOrder[0]);
    spy.mockRestore();
  });

  it.each([
    ["failed", options({ sendMail: jest.fn().mockRejectedValue(new Error("Graph 503")) })],
    ["pending (settings missing)", options({ env: { ...ENV, APP_BASE_URL: "" } })],
    ["none (nobody to tell)", options({ users: [] })],
  ])("leaves the job unflagged when the send is %s", async (_label, o) => {
    const spy = onChange();
    await notifyTargets(conn, row(), "raise", o);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("does not touch the job when the send could not even be recorded", async () => {
    const spy = onChange();
    store.recordNotification.mockRejectedValueOnce(new Error("deadlock"));
    await notifyTargets(conn, row(), "raise", options({ log: jest.fn() }));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("never throws when updating the job fails: the email has gone", async () => {
    const spy = onChange().mockRejectedValueOnce(new Error("timeout") as never);
    const log = jest.fn();
    await expect(notifyTargets(conn, row(), "raise", options({ log }))).resolves.toMatchObject({ state: "sent" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("could not update the subject after the email went"));
    spy.mockRestore();
  });
});

describe("links name the step the escalation is about (J6)", () => {
  it.each([
    ["job.invoice_waiting", "Open it in Floorplan: https://floorplan.example/jobs?jobId=12&step=invoices\n"],
    ["job.quote_not_back", "Open it in Floorplan: https://floorplan.example/jobs?jobId=12&step=quotes\n"],
    ["job.stalled_unacknowledged", "Open it in Floorplan: https://floorplan.example/jobs?jobId=12\n"],
  ])("%s", async (policyKey, line) => {
    const o = options();
    await notifyTargets(conn, row({ policyKey }), "raise", o);
    expect(o.sendMail.mock.calls[0][2]).toContain(line);
  });
});

describe("a failed send is retried and never counts as delivered", () => {
  it("records failed, with the error and attempt, when the send throws", async () => {
    const o = options({ sendMail: jest.fn().mockRejectedValue(new Error("Graph sendMail failed: 503")) });

    const outcome = await notifyTargets(conn, row(), "raise", o);

    expect(outcome).toMatchObject({ attempts: 1, error: "Graph sendMail failed: 503", state: "failed" });
    expect(recorded()[0].outcome).toMatchObject({ error: "Graph sendMail failed: 503", notifiedAt: null, state: "failed" });
    expect(recorded()[0].outcome.state).not.toBe("sent");
  });

  it("tries again with a growing wait before giving up, and keeps the last error", async () => {
    const sendMail = jest.fn().mockRejectedValue(new Error("boom"));
    const o = options({ attempts: 3, backoffMs: 100, sendMail });

    const outcome = await notifyTargets(conn, row(), "raise", o);

    expect(sendMail).toHaveBeenCalledTimes(3);
    expect(o.sleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
    expect(outcome).toMatchObject({ attempts: 3, error: "boom", state: "failed" });
    expect(recorded()[0].attempts).toBe(3);
  });

  it("is sent and counted at the attempt that worked", async () => {
    const sendMail = jest.fn().mockRejectedValueOnce(new Error("blip")).mockRejectedValueOnce(new Error("blip")).mockResolvedValueOnce(undefined);
    const o = options({ attempts: 3, backoffMs: 1, sendMail });

    const outcome = await notifyTargets(conn, row(), "raise", o);

    expect(outcome).toMatchObject({ attempts: 3, error: null, state: "sent" });
    expect(recorded()[0].outcome.notifiedAt).toEqual(NOW);
  });

  it("does not wait after the last try", async () => {
    const o = options({ attempts: 1, sendMail: jest.fn().mockRejectedValue(new Error("x")) });
    await notifyTargets(conn, row(), "raise", o);
    expect(o.sleep).not.toHaveBeenCalled();
  });

  it("keeps the escalation intact if even the bookkeeping fails: it never throws", async () => {
    store.recordNotification.mockRejectedValueOnce(new Error("deadlock"));
    const log = jest.fn();
    const o = options({ log });

    await expect(notifyTargets(conn, row(), "raise", o)).resolves.toMatchObject({ state: "sent" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("could not record the notification outcome"));
  });

  it("never throws when the directory can't be read either", async () => {
    store.listActiveUsers.mockRejectedValueOnce(new Error("db down"));
    const o = options({ users: undefined });
    await expect(notifyTargets(conn, row(), "raise", o)).resolves.toMatchObject({ error: "db down", state: "failed" });
  });
});

describe("missing settings, nobody to tell", () => {
  it("sends nothing and stays pending, uncounted, while APP_BASE_URL or the sender mailbox is missing", async () => {
    const o = options({ env: { ...ENV, APP_BASE_URL: "", GRAPH_SENDER_EMAIL: undefined } as NodeJS.ProcessEnv });

    const outcome = await notifyTargets(conn, row(), "raise", o);

    expect(o.sendMail).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ attempts: 0, state: "pending" });
    expect(outcome.error).toBe("Notification settings are missing: APP_BASE_URL, GRAPH_SENDER_EMAIL");
    expect(recorded()[0]).toMatchObject({ attempts: 0, outcome: { state: "pending" } });
  });

  it("is 'none' when nobody at the level has an email address", async () => {
    const o = options({ users: [user(1, "Adam", "facilities_manager", null)] });
    const outcome = await notifyTargets(conn, row(), "raise", o);
    expect(outcome).toMatchObject({ attempts: 0, state: "none" });
    expect(o.sendMail).not.toHaveBeenCalled();
  });
});

describe("recipients", () => {
  it("are active AppUsers by role, leaving out the raiser", () => {
    const users = [ADAM, BEA, user(8, "Fay", "facilities_manager")];
    expect(targetUsers(row({ raisedByUserId: 8 }), users).map((u) => u.name)).toEqual(["Adam", "Bea"]);
  });

  it("are the named person alone when a person was picked or acknowledged", () => {
    expect(targetUsers(row({ targetUserId: 2 }), USERS).map((u) => u.name)).toEqual(["Bea"]);
  });

  it("leave out people the context excludes (the preparer of an authority escalation)", () => {
    expect(targetUsers(row({ context: { excludeUserIds: [1] } }), USERS).map((u) => u.name)).toEqual(["Bea"]);
  });

  it("go to the directors and admin when nobody independent was available", () => {
    const flagged = row({ noIndependentTarget: true, raisedByUserId: 5, targetRole: "director" });
    expect(targetUsers(flagged, USERS).map((u) => u.name)).toEqual(["Eli", "Ada"]);
  });

  it("use FACILITIES_MANAGER_EMAILS only while no active facilities manager exists", () => {
    const env = { FACILITIES_MANAGER_EMAILS: "boss@example.com, Adam@Example.com" } as NodeJS.ProcessEnv;

    expect(targetAddresses(row(), [DEE], env)).toEqual(["boss@example.com", "Adam@Example.com"]);
    expect(targetAddresses(row(), [ADAM, DEE], env)).toEqual(["adam@example.com"]);
    // the raiser's own address is left out of the stand-in list
    expect(targetAddresses(row({ raisedByUserId: 1 }), [ADAM, DEE], env)).toEqual(["boss@example.com", "Adam@Example.com"].filter((a) => a.toLowerCase() !== "adam@example.com"));
  });

  it("don't fall back for other roles", () => {
    const env = { FACILITIES_MANAGER_EMAILS: "boss@example.com" } as NodeJS.ProcessEnv;
    expect(targetAddresses(row({ targetRole: "director" }), [ADAM], env)).toEqual([]);
  });
});

describe("supersede: tell the previous level", () => {
  const previous = row({ escalationId: 41, status: "superseded" });
  const next = row({ escalationId: 42, level: 2, parentEscalationId: 41, targetRole: "director" });

  it("sends an FYI to the people who had it, with the new level's row", async () => {
    const o = options();
    await notifyPreviousLevel(conn, previous, next, o);

    expect(o.sendMail).toHaveBeenCalledTimes(1);
    const [to, subject, body] = o.sendMail.mock.calls[0];
    expect(to).toEqual(["adam@example.com", "bea@example.com"]);
    expect(subject).toMatch(/^FYI, moved up: /);
    expect(body).toContain("You don't need to do anything");
    expect(body).toContain("jobId=12");
  });

  it("leaves out people who are also at the new level, who got the real email", async () => {
    const o = options();
    await notifyPreviousLevel(conn, previous, { ...next, targetRole: "facilities_manager" }, o);
    expect(o.sendMail).not.toHaveBeenCalled();
  });

  it("does nothing while settings are missing, and a failure is only logged", async () => {
    const quiet = options({ env: {} as NodeJS.ProcessEnv });
    await notifyPreviousLevel(conn, previous, next, quiet);
    expect(quiet.sendMail).not.toHaveBeenCalled();

    const log = jest.fn();
    const failing = options({ log, sendMail: jest.fn().mockRejectedValue(new Error("nope")) });
    await expect(notifyPreviousLevel(conn, previous, next, failing)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("could not tell the previous level"));
  });

  it("is not tracked on the escalation", async () => {
    await notifyPreviousLevel(conn, previous, next, options());
    expect(store.recordNotification).not.toHaveBeenCalled();
  });
});

describe("resolve: tell a human raiser", () => {
  const done = row({ resolvedByUserId: 1, resolvedByName: "Adam", status: "resolved" });

  it("emails the person who raised it", async () => {
    const o = options();
    await notifyRaiserResolved(conn, done, o);

    expect(o.sendMail).toHaveBeenCalledTimes(1);
    expect(o.sendMail.mock.calls[0][0]).toEqual(["fay@example.com"]);
    expect(o.sendMail.mock.calls[0][1]).toMatch(/^Resolved: /);
    expect(o.sendMail.mock.calls[0][2]).not.toContain("Respond by");
  });

  it("does not email a system raiser, or someone who resolved their own", async () => {
    const o = options();
    await notifyRaiserResolved(conn, { ...done, raisedByKind: "system", raisedByUserId: null }, o);
    await notifyRaiserResolved(conn, { ...done, resolvedByUserId: 8 }, o);
    expect(o.sendMail).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    const o = options({ log: jest.fn(), sendMail: jest.fn().mockRejectedValue(new Error("nope")) });
    await expect(notifyRaiserResolved(conn, done, o)).resolves.toBeUndefined();
  });
});

describe("buildEmail", () => {
  it("falls back to a plain pointer when there is no link", () => {
    const { body } = buildEmail("raise", row(), null);
    expect(body).toContain("Open Floorplan to see it.");
    expect(body).not.toContain("http");
  });

  it("says an automatic escalation came from Floorplan", () => {
    const { body } = buildEmail("raise", row({ raisedByKind: "system", raisedByName: "Floorplan" }), "https://x/y");
    expect(body).toContain("Raised by: Floorplan (automatic)");
  });

  it("cuts a long note short", () => {
    const { body } = buildEmail("raise", row({ note: "n".repeat(900) }), "https://x/y");
    expect(body).toContain(`${"n".repeat(300)}...`);
    expect(body).not.toContain("n".repeat(301));
  });
});

describe("when the sweep retries", () => {
  const minutes = (m: number) => new Date(NOW.getTime() - m * 60_000);

  it("backs off 15 minutes, 30, 1h, 2h, 4h and then 8h at most", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => retryDelayMs(n) / 60_000)).toEqual([15, 30, 60, 120, 240, 480, 480]);
  });

  it("retries a failed send once its back-off has passed", () => {
    const failed = row({ lastNotificationAttemptAt: minutes(14), notificationAttempts: 1, notificationState: "failed" });
    expect(isRetryDue(failed, NOW)).toBe(false);
    expect(isRetryDue({ ...failed, lastNotificationAttemptAt: minutes(15) }, NOW)).toBe(true);
    expect(isRetryDue({ ...failed, lastNotificationAttemptAt: minutes(29), notificationAttempts: 2 }, NOW)).toBe(false);
    expect(isRetryDue({ ...failed, lastNotificationAttemptAt: minutes(31), notificationAttempts: 2 }, NOW)).toBe(true);
  });

  it("gives up after the attempts run out", () => {
    const spent = row({ lastNotificationAttemptAt: minutes(999), notificationAttempts: MAX_NOTIFICATION_ATTEMPTS, notificationState: "failed" });
    expect(isRetryDue(spent, NOW)).toBe(false);
  });

  it("sends a pending notification that never left, after a few minutes' grace", () => {
    expect(isRetryDue(row({ createdAt: minutes(4), notificationState: "pending" }), NOW)).toBe(false);
    expect(isRetryDue(row({ createdAt: minutes(6), notificationState: "pending" }), NOW)).toBe(true);
  });

  it("leaves sent, none and closed ones alone", () => {
    expect(isRetryDue(row({ createdAt: minutes(999), notificationState: "sent" }), NOW)).toBe(false);
    expect(isRetryDue(row({ createdAt: minutes(999), notificationState: "none" }), NOW)).toBe(false);
    expect(isRetryDue(row({ createdAt: minutes(999), notificationState: "pending", status: "resolved" }), NOW)).toBe(false);
  });

  it("resends the email the row would have got first", () => {
    expect(eventForRetry(row())).toBe("raise");
    expect(eventForRetry(row({ parentEscalationId: 41 }))).toBe("supersede");
  });
});

describe("escalation emails about a test job (D9)", () => {
  beforeEach(() => {
    store.listActiveUsers.mockResolvedValue(USERS);
    testData.readIsTest.mockReset().mockResolvedValue(false);
  });

  it("sends nothing for a test job, records why, and leaves nothing to retry", async () => {
    testData.readIsTest.mockResolvedValue(true);
    const sendMail = jest.fn();
    const outcome = await notifyTargets(conn, row(), "raise", { env: ENV, now: () => NOW, sendMail });
    expect(testData.readIsTest).toHaveBeenCalledWith(conn, "job", 12);
    expect(sendMail).not.toHaveBeenCalled();
    expect(outcome).toEqual({ attempts: 0, error: "Not sent: test record", recipients: [], state: "none" });
  });

  it("tells the sender what a real job's email is about", async () => {
    const sendMail = jest.fn().mockResolvedValue(undefined);
    await notifyTargets(conn, row(), "raise", { env: ENV, now: () => NOW, sendMail });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][3]).toEqual({ isTest: false });
  });

  it.each([
    ["tenancy", "7", "tenancy", 7],
    ["rent_review", "rr-9", "rent_review", "rr-9"],
    ["schedule_change", "sc-1", "schedule_change", "sc-1"],
    ["quote", "33", "quote", 33],
    ["defects_period", "4", "defects_period", 4],
  ])("asks whether a %s subject is a test record (A0-A2 decisions, WP25/WP26 reviews)", async (subjectType, subjectId, kind, id) => {
    testData.readIsTest.mockResolvedValue(true);
    const sendMail = jest.fn();
    const outcome = await notifyTargets(conn, row({ subjectId, subjectType }), "raise", { env: ENV, now: () => NOW, sendMail });
    expect(testData.readIsTest).toHaveBeenCalledWith(conn, kind, id);
    expect(sendMail).not.toHaveBeenCalled();
    expect(outcome.error).toBe("Not sent: test record");
  });

  it("does not look anything up for a subject that isn't a record (system health)", async () => {
    const sendMail = jest.fn().mockResolvedValue(undefined);
    await notifyTargets(conn, row({ subjectId: "myob.agreement", subjectType: "system" }), "raise", { env: ENV, now: () => NOW, sendMail });
    expect(testData.readIsTest).not.toHaveBeenCalled();
    expect(sendMail.mock.calls[0]?.[3]).toBe("not-a-record");
  });

  it("does not tell the previous level or the raiser about a test job", async () => {
    testData.readIsTest.mockResolvedValue(true);
    const sendMail = jest.fn();
    await notifyPreviousLevel(conn, row({ level: 1 }), row({ escalationId: 43, level: 2 }), { env: ENV, sendMail });
    await notifyRaiserResolved(conn, row({ resolvedByUserId: 5, status: "resolved" }), { env: ENV, sendMail });
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe("escalation emails when the test-record check itself fails (D9 review: fail closed)", () => {
  beforeEach(() => {
    store.listActiveUsers.mockResolvedValue(USERS);
    testData.readIsTest.mockReset().mockRejectedValue(new Error("database unreachable"));
  });

  it("notifyTargets sends nothing and records the send as failed", async () => {
    const sendMail = jest.fn();
    const outcome = await notifyTargets(conn, row(), "raise", { env: ENV, now: () => NOW, sendMail });
    expect(sendMail).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ attempts: 0, error: "database unreachable", state: "failed" });
  });

  it("the previous level and the raiser are not told either", async () => {
    const sendMail = jest.fn();
    const log = jest.fn();
    const previous = row({ escalationId: 41, level: 1, targetRole: "facilities_manager" });
    const next = row({ escalationId: 42, level: 2, parentEscalationId: 41, targetRole: "director" });
    await notifyPreviousLevel(conn, previous, next, { env: ENV, log, sendMail, users: USERS });
    await notifyRaiserResolved(conn, row({ resolvedByUserId: 5, status: "resolved" }), { env: ENV, log, sendMail, users: USERS });
    expect(sendMail).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("could not tell the previous level: database unreachable"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("could not tell the raiser: database unreachable"));
  });
});
