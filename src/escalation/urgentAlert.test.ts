/// <reference types="jest" />
import type { Connection } from "tedious";
import type { Alert, AlertChannel, AlertResult, AlertStatus } from "../alerts/channel";
import { notifyTargets, type NotifyOptions } from "./notifier";
import "./adapters";
import { alertCopy, alertKind, isUrgentAlert } from "./urgentAlert";
import type { DirectoryUser, EscalationRow } from "./types";

jest.mock("./store", () => ({
  listActiveUsers: jest.fn(),
  recordNotification: jest.fn().mockResolvedValue(undefined),
}));
const store = require("./store") as { recordNotification: jest.Mock };
jest.mock("../test-data", () => ({ ...jest.requireActual("../test-data"), readIsTest: jest.fn().mockResolvedValue(false) }));
jest.mock("../db", () => ({ executeQuery: jest.fn().mockResolvedValue([]) }));

const conn = {} as Connection;
const NOW = new Date("2026-10-13T01:00:00Z");
const ENV = {
  APP_BASE_URL: "https://floorplan.example/",
  GRAPH_CLIENT_ID: "id",
  GRAPH_CLIENT_SECRET: "secret",
  GRAPH_SENDER_EMAIL: "floorplan@example.com",
  GRAPH_TENANT_ID: "tenant",
  TEAMS_ALERTS_ENABLED: "true",
} as NodeJS.ProcessEnv;

const user = (userId: number, name: string, role: string, entraOid: string | null): DirectoryUser => ({
  email: `${name.toLowerCase()}@example.com`,
  entraOid,
  name,
  role,
  userId,
});
const DEE = user(5, "Dee", "director", "oid-dee");
const ELI = user(6, "Eli", "director", null);
const FAY = user(8, "Fay", "facilities", null);
const USERS = [DEE, ELI, FAY];

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


const urgentRow = (over: Partial<EscalationRow> = {}): EscalationRow =>
  row({ policyKey: "job.critical", targetRole: "director", urgent: true, ...over });

function channel(status: AlertStatus | Error = "sent"): AlertChannel & { send: jest.Mock } {
  const send = jest.fn(async (): Promise<AlertResult> => {
    if (status instanceof Error) throw status;
    return { detail: null, status };
  });
  return { name: "teams", needs: "entraOid", send };
}

function options(channels: AlertChannel[], over: Partial<NotifyOptions> = {}): NotifyOptions & { sendMail: jest.Mock } {
  return { alertFlag: async () => true, channels, env: ENV, now: () => NOW, sendMail: jest.fn().mockResolvedValue(undefined), users: USERS, ...over } as NotifyOptions & {
    sendMail: jest.Mock;
  };
}

const recordedChannel = (): unknown => store.recordNotification.mock.calls[0][2].channel;

beforeEach(() => jest.clearAllMocks());

describe("urgent alerts (D21)", () => {
  it("urgent raise: a sent alert replaces that person's email and the channel is recorded", async () => {
    const ch = channel("sent");
    const o = options([ch]);

    const outcome = await notifyTargets(conn, urgentRow(), "raise", o);

    expect(ch.send).toHaveBeenCalledTimes(1);
    expect(ch.send.mock.calls[0][0]).toEqual({ email: "dee@example.com", entraOid: "oid-dee" });
    // Eli has no Entra id yet: he still gets the email, Dee does not.
    expect(o.sendMail.mock.calls[0][0]).toEqual(["eli@example.com"]);
    expect(outcome).toMatchObject({ channel: "teams", state: "sent" });
    expect(recordedChannel()).toBe("teams");
  });

  it("is sent with no email at all when every target was alerted", async () => {
    const ch = channel("sent");
    const o = options([ch], { users: [DEE] });

    const outcome = await notifyTargets(conn, urgentRow(), "raise", o);

    expect(o.sendMail).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ attempts: 0, channel: "teams", error: null, state: "sent" });
  });

  it("alerts on a reminder too", async () => {
    const ch = channel("sent");
    await notifyTargets(conn, urgentRow({ notificationState: "sent" }), "reminder", options([ch], { users: [DEE] }));
    expect(ch.send).toHaveBeenCalledTimes(1);
  });

  it.each(["not_permitted", "retry", "dry_run", "skipped", "no_user", "duplicate_app", "failed"] as const)(
    "falls back to email when the channel says %s",
    async (status) => {
      const ch = channel(status);
      const o = options([ch], { users: [DEE] });

      const outcome = await notifyTargets(conn, urgentRow(), "raise", o);

      expect(ch.send).toHaveBeenCalledTimes(1);
      expect(o.sendMail.mock.calls[0][0]).toEqual(["dee@example.com"]);
      expect(outcome).toMatchObject({ channel: "email", state: "sent" });
      expect(recordedChannel()).toBe("email");
    },
  );

  it("falls back to email when the channel throws", async () => {
    const o = options([channel(new Error("boom"))], { users: [DEE] });
    await notifyTargets(conn, urgentRow(), "raise", o);
    expect(o.sendMail).toHaveBeenCalledTimes(1);
  });

  it("never tries a target with no Entra id", async () => {
    const ch = channel("sent");
    const o = options([ch], { users: [ELI] });
    await notifyTargets(conn, urgentRow(), "raise", o);
    expect(ch.send).not.toHaveBeenCalled();
    expect(o.sendMail).toHaveBeenCalledTimes(1);
  });

  it("does not alert again when re-sending a failed send", async () => {
    const ch = channel("sent");
    const o = options([ch], { users: [DEE] });
    await notifyTargets(conn, urgentRow({ notificationState: "failed" }), "raise", o);
    expect(ch.send).not.toHaveBeenCalled();
    expect(o.sendMail).toHaveBeenCalledTimes(1);
  });

  it("non-urgent events never touch the channel", async () => {
    const ch = channel("sent");
    const o = options([ch], { users: [DEE] });
    await notifyTargets(conn, row({ targetRole: "director" }), "raise", o);
    expect(ch.send).not.toHaveBeenCalled();
    expect(o.sendMail).toHaveBeenCalledTimes(1);
    expect(recordedChannel()).toBe("email");
  });

  it("follow_up is never alerted, even on an urgent row", async () => {
    const ch = channel("sent");
    await notifyTargets(conn, urgentRow(), "follow_up", options([ch], { users: [DEE] }));
    expect(ch.send).not.toHaveBeenCalled();
  });

  it("with no channel switched on the email goes as before", async () => {
    const o = options([], { users: [DEE] });
    const outcome = await notifyTargets(conn, urgentRow(), "raise", o);
    expect(o.sendMail).toHaveBeenCalledTimes(1);
    expect(outcome.channel).toBe("email");
  });

  it("a test record is neither alerted nor emailed", async () => {
    const { readIsTest } = require("../test-data") as { readIsTest: jest.Mock };
    readIsTest.mockResolvedValueOnce(true);
    const ch = channel("sent");
    const o = options([ch]);
    await notifyTargets(conn, urgentRow(), "raise", o);
    expect(ch.send).not.toHaveBeenCalled();
    expect(o.sendMail).not.toHaveBeenCalled();
  });
});

describe("gating: ops mode and the teamsAlerts flag", () => {
  it("flag off for the target's role: email only, channel never tried", async () => {
    const ch = channel("sent");
    const alertFlag = jest.fn().mockResolvedValue(false);
    const o = options([ch], { alertFlag, users: [DEE] });
    const outcome = await notifyTargets(conn, urgentRow(), "raise", o);
    expect(alertFlag).toHaveBeenCalledWith("director");
    expect(ch.send).not.toHaveBeenCalled();
    expect(o.sendMail.mock.calls[0][0]).toEqual(["dee@example.com"]);
    expect(outcome.channel).toBe("email");
  });

  it("is per person: only roles with the flag are alerted", async () => {
    const ch = channel("sent");
    const o = options([ch], { alertFlag: async (role) => role === "director", users: [DEE, { ...DEE, entraOid: "oid-fay", name: "Fay", role: "facilities", userId: 9 }] });
    await notifyTargets(conn, urgentRow({ targetRole: "director" }), "raise", o);
    expect(ch.send).toHaveBeenCalledTimes(1);
  });

  it("mode off: email only, and the flag is not even read", async () => {
    const ch = channel("sent");
    const alertFlag = jest.fn().mockResolvedValue(true);
    const o = options([ch], { alertFlag, env: { ...ENV, TEAMS_ALERTS_ENABLED: undefined } as NodeJS.ProcessEnv, users: [DEE] });
    await notifyTargets(conn, urgentRow(), "raise", o);
    expect(ch.send).not.toHaveBeenCalled();
    expect(alertFlag).not.toHaveBeenCalled();
    expect(o.sendMail).toHaveBeenCalledTimes(1);
  });

  it("mode on and flag on: the channel is called", async () => {
    const ch = channel("sent");
    await notifyTargets(conn, urgentRow(), "raise", options([ch], { users: [DEE] }));
    expect(ch.send).toHaveBeenCalledTimes(1);
  });

  it("the default flag read fails closed (no FeatureFlags rows from the mocked db): email only", async () => {
    const ch = channel("sent");
    const o = options([ch], { alertFlag: undefined, users: [DEE] });
    await notifyTargets(conn, urgentRow(), "raise", o);
    expect(ch.send).not.toHaveBeenCalled();
    expect(o.sendMail).toHaveBeenCalledTimes(1);
  });

  it("a workflows channel needs an email, not an Entra id", async () => {
    const send = jest.fn(async (): Promise<AlertResult> => ({ detail: null, status: "sent" }));
    const wf: AlertChannel = { name: "workflows", needs: "email", send };
    const o = options([wf], { users: [ELI, { ...FAY, email: null }] });
    const outcome = await notifyTargets(conn, urgentRow({ kind: "authority" }), "raise", o);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]).toEqual([{ email: "eli@example.com", entraOid: null }, expect.objectContaining({ kind: "decision" })]);
    expect(outcome).toMatchObject({ channel: "teams", state: "sent" });
  });
});

describe("alertKind", () => {
  it("is reminder for a reminder, decision for an authority row, else escalation", () => {
    expect(alertKind("reminder", row({ kind: "authority" }))).toBe("reminder");
    expect(alertKind("raise", row({ kind: "authority" }))).toBe("decision");
    expect(alertKind("supersede", row({ kind: "authority" }))).toBe("decision");
    expect(alertKind("raise", row())).toBe("escalation");
  });
});

describe("isUrgentAlert", () => {
  it("covers a flagged row, level 2 and up, and an authority decision for a director", () => {
    expect(isUrgentAlert(row())).toBe(false);
    expect(isUrgentAlert(row({ urgent: true }))).toBe(true);
    expect(isUrgentAlert(row({ level: 2 }))).toBe(true);
    expect(isUrgentAlert(row({ kind: "authority", targetRole: "director" }))).toBe(true);
    expect(isUrgentAlert(row({ kind: "authority", targetRole: "cfo" }))).toBe(false);
    expect(isUrgentAlert(row({ kind: "attention", targetRole: "director" }))).toBe(false);
  });
});

describe("alert copy", () => {
  it("is a generic pointer: no amounts, names, addresses or the row's summary", async () => {
    const ch = channel("sent");
    const r = urgentRow({ note: "Pay $12,500 to Acme Plumbing", summary: "Invoice $12,500 for 14 Smith St from Acme Plumbing" });
    await notifyTargets(conn, r, "raise", options([ch], { users: [DEE] }));
    const alert = ch.send.mock.calls[0][1] as Alert;
    const shown = `${alert.previewText} ${alert.text}`;
    expect(shown).not.toMatch(/\d/);
    expect(shown).not.toMatch(/\$/);
    for (const name of ["Acme", "Smith", "Fay", "Dee", "Eli"]) expect(shown).not.toContain(name);
    expect(alert.route.startsWith("/")).toBe(true);
  });

  it("has a variant for reminders", () => {
    expect(alertCopy("reminder").text).toContain("still waiting");
    expect(alertCopy("raise").text).not.toContain("still waiting");
  });
});
