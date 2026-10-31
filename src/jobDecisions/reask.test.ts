/// <reference types="jest" />
// A deferred question coming back (jobs plan A2): who it is asked of the second time,
// how long they are given, that it is asked exactly once, and that it is asked in one
// transaction with the sweep as the one who did it. The store, the engine and the
// ledger are replaced by an in-memory stand-in, because they have their own tests.
import type { Connection } from "tedious";
import { raiseWithin } from "../escalation/engine";
import { listActiveUsers } from "../escalation/store";
import type { DirectoryUser, EscalationRow } from "../escalation/types";
import { record } from "../ledger";
import * as decisions from "./decisionsStore";
import type { DecisionRow, DueDeferral } from "./decisionsStore";
import { reaskDeferral, reaskMakers } from "./reask";
import { RequestError } from "./request";
import * as requests from "./store";
import type { DecisionRequestRow } from "./store";

jest.mock("../db", () => ({
  beginTransaction: jest.fn(),
  commitTransaction: jest.fn(),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn(),
}));
jest.mock("../ledger", () => ({ ...jest.requireActual("../ledger"), record: jest.fn() }));
jest.mock("../escalation/engine", () => ({ SWEEP_ACTOR: { kind: "system", name: "escalationSweepTimer" }, raiseWithin: jest.fn(), withdrawWithin: jest.fn() }));
jest.mock("../escalation/store", () => ({ ...jest.requireActual("../escalation/store"), listActiveUsers: jest.fn() }));
jest.mock("./store", () => ({ ...jest.requireActual("./store"), getRequestRow: jest.fn(), insertRequest: jest.fn(), lockJob: jest.fn() }));
jest.mock("./decisionsStore", () => ({ getDecisionRow: jest.fn(), hasLaterRequest: jest.fn(), stampReask: jest.fn() }));

const db = require("../db") as { beginTransaction: jest.Mock; commitTransaction: jest.Mock; rollbackTransaction: jest.Mock };
const ledger = jest.mocked(record);
const raise = jest.mocked(raiseWithin);
const usersOf = jest.mocked(listActiveUsers);
const store = requests as unknown as { getRequestRow: jest.Mock; insertRequest: jest.Mock; lockJob: jest.Mock };
const dec = decisions as unknown as Record<string, jest.Mock>;

const conn = {} as Connection;
// Friday 2026-10-23, 09:00 Darwin: the day a deferral comes due
const NOW = new Date(Date.UTC(2026, 9, 23, 9, 0) - 9.5 * 3_600_000);
const VERSION = Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]).toString("base64");

const user = (userId: number, name: string, role: string): DirectoryUser => ({ email: `${name.toLowerCase()}@example.com`, name, role, userId });
const CAM = user(3, "Cam", "accounts_manager");
const KIRSTIN = user(4, "Kirstin", "accounts_manager");
const DEE = user(5, "Dee", "director");
const ELI = user(6, "Eli", "director");
const FAY = user(8, "Fay", "facilities");
const ALANA = user(9, "Alana", "accounts");
const UNA = user(20, "Una", "user");
const USERS = [CAM, KIRSTIN, DEE, ELI, FAY, ALANA, UNA];

const original = (over: Partial<DecisionRequestRow> = {}): DecisionRequestRow => ({
  assignmentMode: "named",
  autoEscalate: true,
  decisionMakers: { role: null, userIds: [CAM.userId, DEE.userId] },
  jobId: 12,
  question: "Pay the superseded lighting invoice?",
  requestId: 7,
  requestedAt: new Date("2026-10-12T00:00:00Z"),
  requestedBy: "Alana",
  requestedByUserId: ALANA.userId,
  respondBy: new Date("2026-10-19T07:00:00Z"),
  routineWeeks: null,
  rowVersion: VERSION,
  sourceAttachmentId: 77,
  state: "answered",
  tier: "soon",
  withdrawnAt: null,
  withdrawnBy: null,
  withdrawnByUserId: null,
  withdrawnReason: null,
  ...over,
});

const deferral = (over: Partial<DecisionRow> = {}): DecisionRow => ({
  decisionId: 4,
  deferUntil: "2026-10-23",
  jobId: 12,
  nextStep: null,
  nextStepClosed: null,
  nextStepDueAt: null,
  nextStepOwnerRole: null,
  nextStepOwnerUserId: null,
  outcome: "defer",
  rationale: "Wait for the corrected invoice",
  reaskRequestId: null,
  requestId: 7,
  respondedAt: new Date("2026-10-12T00:30:00Z"),
  respondedById: CAM.userId,
  respondedByName: "Cam",
  rowVersion: VERSION,
  ...over,
});

const DUE: DueDeferral = { decisionId: 4, deferUntil: "2026-10-23", jobId: 12, requestId: 7 };
const JOB = { buildingId: 5, buildingName: "25 Temira Crescent", isArchived: false, jobId: 12, kind: "admin", status: "Work", title: "Superseded lighting invoice" };
const NEW_ROW = { escalationId: 200, policyKey: "job.decision_pending" } as unknown as EscalationRow;

interface World {
  decision: DecisionRow | null;
  events: string[];
  insertError: Error | null;
  inserted: DecisionRequestRow | null;
  job: typeof JOB | null;
  later: boolean;
  original: DecisionRequestRow | null;
  raised: boolean;
  stamped: boolean;
}
let world: World;

beforeEach(() => {
  jest.clearAllMocks();
  world = { decision: deferral(), events: [], insertError: null, inserted: null, job: { ...JOB }, later: false, original: original(), raised: true, stamped: true };
  usersOf.mockResolvedValue(USERS);
  store.lockJob.mockImplementation(async () => world.job);
  dec.getDecisionRow.mockImplementation(async () => world.decision);
  dec.hasLaterRequest.mockImplementation(async () => world.later);
  dec.stampReask.mockImplementation(async () => {
    world.events.push("stamp");
    return world.stamped;
  });
  store.getRequestRow.mockImplementation(async (_c: unknown, id: number) => (id === 7 ? world.original : world.inserted));
  store.insertRequest.mockImplementation(async (_c: unknown, request: Record<string, unknown>) => {
    world.events.push("insert request");
    if (world.insertError) throw world.insertError;
    world.inserted = original({ ...(request as Partial<DecisionRequestRow>), requestId: 9, state: "pending" });
    return 9;
  });
  raise.mockImplementation((async () => {
    world.events.push("raise");
    return {
      announce: async () => {
        world.events.push("announce");
        return NEW_ROW;
      },
      created: world.raised,
      escalation: NEW_ROW,
    };
  }) as never);
  db.beginTransaction.mockImplementation(async () => world.events.push("begin"));
  db.commitTransaction.mockImplementation(async () => world.events.push("commit"));
  db.rollbackTransaction.mockImplementation(async () => world.events.push("rollback"));
  ledger.mockImplementation(async (_c, entry) => {
    world.events.push(`ledger:${entry.action}`);
  });
});

const run = (over: Partial<Parameters<typeof reaskDeferral>[2]> = {}) => reaskDeferral(conn, DUE, { now: NOW, ...over });
const refused = async (promise: Promise<unknown>): Promise<RequestError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RequestError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
};
const skippedWithNothingWritten = () => {
  expect(store.insertRequest).not.toHaveBeenCalled();
  expect(raise).not.toHaveBeenCalled();
  expect(ledger).not.toHaveBeenCalled();
  expect(world.events).not.toContain("commit");
  expect(world.events).not.toContain("announce");
};

describe("asking a deferred question again", () => {
  it("writes the new request, stamps the deferral, raises the chase and ledgers it in one transaction, and emails after the commit", async () => {
    expect(await run()).toBe("asked");

    expect(world.events).toEqual(["begin", "insert request", "stamp", "raise", "ledger:decision.requested", "commit", "announce"]);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
  });

  it("asks the same question of the same people, in the name of the person who first asked, with the file it was about", async () => {
    await run();

    expect(store.insertRequest).toHaveBeenCalledWith(conn, {
      assignmentMode: "named",
      autoEscalate: true,
      decisionMakers: { role: null, userIds: [CAM.userId, DEE.userId] },
      jobId: 12,
      question: "Pay the superseded lighting invoice?",
      requestedBy: "Alana",
      requestedByUserId: ALANA.userId,
      respondBy: new Date("2026-10-30T07:00:00Z"), // soon: a week from today, close of business Darwin
      routineWeeks: null,
      sourceAttachmentId: 77,
      tier: "soon",
    });
    expect(dec.stampReask).toHaveBeenCalledWith(conn, 4, 9);
  });

  it("raises it as the sweep, for the person who first asked, whose manager it moves up to, under the decision policy on the job", async () => {
    await run();

    const [connection, args] = raise.mock.calls[0];
    expect(connection).toBe(conn);
    expect(args).toMatchObject({
      actor: { kind: "system", name: "escalationSweepTimer" },
      dueAt: new Date("2026-10-30T07:00:00Z"),
      headline: "Decision needed (asked again): Pay the superseded lighting invoice?",
      ladderRaiser: { role: "accounts", userId: ALANA.userId },
      note: "Pay the superseded lighting invoice?",
      now: NOW,
      policyKey: "job.decision_pending",
      reason: "needs_decision",
      subjectId: "12",
      subjectType: "job",
      urgent: false,
      userTargets: [CAM.userId, DEE.userId],
    });
    expect(args.notify).toEqual({ attempts: 1 });
    expect(args.context).toEqual({
      decision: {
        assignmentMode: "named",
        autoEscalate: true,
        callThem: false,
        jobLabel: "Job #12 · Superseded lighting invoice · 25 Temira Crescent",
        question: "Pay the superseded lighting invoice?",
        reaskOf: { askedBy: "Alana", decisionId: 4, deferredUntil: "2026-10-23" },
        requestId: 9,
        respondBy: "2026-10-30T07:00:00.000Z",
        tier: "soon",
      },
      schedule: { escalateAt: "2026-10-30T07:00:00.000Z", remindAt: ["2026-10-28T23:00:00.000Z"] },
    });
    expect(args.correlationId).toBe(ledger.mock.calls[0][1].correlationId);
  });

  it("ledgers decision.requested as the sweep, under decision_request.reask, saying which deferral it follows", async () => {
    await run();

    expect(ledger).toHaveBeenCalledTimes(1);
    expect(ledger.mock.calls[0][1]).toMatchObject({
      action: "decision.requested",
      actor: { kind: "system", name: "escalationSweepTimer" },
      buildingId: 5,
      jobId: 12,
      ruleApplied: "decision_request.reask",
      subject: { id: 12, type: "job" },
    });
    expect(ledger.mock.calls[0][1].after).toMatchObject({
      question: "Pay the superseded lighting invoice?",
      reaskOf: { askedBy: "Alana", decisionId: 4, deferredUntil: "2026-10-23" },
      requestId: 9,
      state: "pending",
      tier: "soon",
    });
  });

  it("passes the send options on, one try by default", async () => {
    await run({ notify: { attempts: 3, backoffMs: 1000 } });
    expect(raise.mock.calls[0][1].notify).toEqual({ attempts: 3, backoffMs: 1000 });
  });

  it("is raised without a person to take the manager from when the one who asked can no longer be found, and the ladder is the sweep's", async () => {
    usersOf.mockResolvedValue(USERS.filter((u) => u.userId !== ALANA.userId));
    await run();
    expect(raise.mock.calls[0][1].ladderRaiser).toBeUndefined();
  });

  it("is raised without an asker at all if the original had none recorded", async () => {
    world.original = original({ requestedByUserId: null });
    await run();
    expect(raise.mock.calls[0][1].ladderRaiser).toBeUndefined();
    expect(store.insertRequest.mock.calls[0][1]).toMatchObject({ requestedByUserId: null });
  });
});

describe("how long they are given the second time", () => {
  it("an urgent question comes back urgent, with the asker's tick (or no tick) as it was", async () => {
    world.original = original({ autoEscalate: false, respondBy: new Date("2026-10-13T07:00:00Z"), tier: "urgent" });
    await run();
    expect(store.insertRequest.mock.calls[0][1]).toMatchObject({ autoEscalate: false, respondBy: new Date("2026-10-26T07:00:00Z"), tier: "urgent" });
    expect(raise.mock.calls[0][1]).toMatchObject({ dueAt: null, urgent: true });

    jest.clearAllMocks();
    world.events = [];
    world.original = original({ autoEscalate: true, tier: "urgent" });
    await run();
    expect(store.insertRequest.mock.calls[0][1]).toMatchObject({ autoEscalate: true, tier: "urgent" });
    expect(raise.mock.calls[0][1].dueAt).not.toBeNull();
  });

  it("a routine question gets the same number of weeks from today", async () => {
    world.original = original({ routineWeeks: 3, tier: "routine" });
    await run();
    expect(store.insertRequest.mock.calls[0][1]).toMatchObject({ respondBy: new Date("2026-11-13T07:00:00Z"), routineWeeks: 3, tier: "routine" });
  });

  it("a fixed deadline that is still to come stays the deadline", async () => {
    world.original = original({ respondBy: new Date("2026-10-28T07:00:00Z"), tier: "fixed" });
    await run();
    expect(store.insertRequest.mock.calls[0][1]).toMatchObject({ respondBy: new Date("2026-10-28T07:00:00Z"), tier: "fixed" });
  });

  it("a fixed deadline that went by while it was deferred, and an emergency, come back urgent and moving up", async () => {
    for (const over of [{ respondBy: new Date("2026-10-20T07:00:00Z"), tier: "fixed" as const }, { autoEscalate: false, respondBy: null, tier: "emergency" as const }]) {
      jest.clearAllMocks();
      world.events = [];
      world.original = original(over);
      await run();
      expect(store.insertRequest.mock.calls[0][1]).toMatchObject({ autoEscalate: true, tier: "urgent" });
      expect(raise.mock.calls[0][1].urgent).toBe(true);
    }
  });
});

describe("who it is asked of the second time", () => {
  it("the people named who can still be asked, leaving out anyone who has left or can no longer open the inbox", async () => {
    world.original = original({ decisionMakers: { role: null, userIds: [CAM.userId, DEE.userId, 99, UNA.userId] } });
    await run();
    expect(store.insertRequest.mock.calls[0][1].decisionMakers).toEqual({ role: null, userIds: [CAM.userId, DEE.userId] });
    expect(raise.mock.calls[0][1].userTargets).toEqual([CAM.userId, DEE.userId]);
  });

  it("whoever holds the role now when it was put to a role, the asker left out", async () => {
    world.original = original({ assignmentMode: "role", decisionMakers: { role: "accounts_manager", userIds: [CAM.userId] }, requestedByUserId: KIRSTIN.userId, requestedBy: "Kirstin" });
    await run();
    expect(store.insertRequest.mock.calls[0][1]).toMatchObject({ assignmentMode: "role", decisionMakers: { role: "accounts_manager", userIds: [CAM.userId] }, requestedBy: "Kirstin" });

    jest.clearAllMocks();
    world.events = [];
    world.original = original({ assignmentMode: "role", decisionMakers: { role: "accounts_manager", userIds: [CAM.userId] } });
    await run();
    expect(store.insertRequest.mock.calls[0][1].decisionMakers).toEqual({ role: "accounts_manager", userIds: [CAM.userId, KIRSTIN.userId] });
  });

  it("nobody, if none of them can be asked: a 422 the sweep reports, with nothing written", async () => {
    world.original = original({ decisionMakers: { role: null, userIds: [99, UNA.userId] } });
    const error = await refused(run());
    expect(error).toMatchObject({ code: "decision_maker_unknown", status: 422 });
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    skippedWithNothingWritten();
  });

  it("nobody, if the role has emptied out", async () => {
    world.original = original({ assignmentMode: "role", decisionMakers: { role: "cfo", userIds: [] } });
    expect(await refused(run())).toMatchObject({ code: "role_has_no_one", status: 422 });
    skippedWithNothingWritten();
  });

  it("a role-wide request saved as admin before admin could be asked is not asked again: a 422, nothing written", async () => {
    world.original = original({ assignmentMode: "role", decisionMakers: { role: "admin", userIds: [7] } });
    usersOf.mockResolvedValue([...USERS, user(7, "Ada", "admin")]);
    expect(await refused(run())).toMatchObject({ code: "decision_maker_role_not_allowed", status: 422 });
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    skippedWithNothingWritten();
  });

  it("reaskMakers: a role is asked afresh; named people are filtered, not refused one by one", () => {
    expect(reaskMakers(original({ assignmentMode: "role", decisionMakers: { role: "director", userIds: [DEE.userId] } }), USERS).userIds).toEqual([DEE.userId, ELI.userId]);
    expect(reaskMakers(original({ decisionMakers: { role: null, userIds: [CAM.userId, 99] } }), USERS).userIds).toEqual([CAM.userId]);
  });

  it("reaskMakers: a stored admin role is refused, not resolved to the admins in the directory", () => {
    const directory = [...USERS, user(7, "Ada", "admin")];
    expect(() => reaskMakers(original({ assignmentMode: "role", decisionMakers: { role: "admin", userIds: [] } }), directory)).toThrow(
      expect.objectContaining({ code: "decision_maker_role_not_allowed", status: 422 }),
    );
  });

  it("reaskMakers: an admin a deferred request named (from before admin could not be asked) is not asked again, and a request to nobody else comes back as a 422", () => {
    const ADA = user(7, "Ada", "admin");
    const directory = [...USERS, ADA];
    expect(reaskMakers(original({ decisionMakers: { role: null, userIds: [ADA.userId, DEE.userId] } }), directory).userIds).toEqual([DEE.userId]);
    expect(() => reaskMakers(original({ decisionMakers: { role: null, userIds: [ADA.userId] } }), directory)).toThrow(
      expect.objectContaining({ code: "decision_maker_unknown", status: 422 }),
    );
  });
});

describe("exactly once", () => {
  it("skips, writing nothing, a deferral that has been asked again already", async () => {
    world.decision = deferral({ reaskRequestId: 9 });
    expect(await run()).toBe("skipped");
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    skippedWithNothingWritten();
  });

  it("skips one that is not a deferral, or that is not there", async () => {
    world.decision = deferral({ outcome: "approve" });
    expect(await run()).toBe("skipped");
    world.decision = null;
    expect(await run()).toBe("skipped");
    skippedWithNothingWritten();
  });

  it("skips one whose job has a request since: a person asked again by hand, and that is the one that stands", async () => {
    world.later = true;
    expect(await run()).toBe("skipped");
    skippedWithNothingWritten();
    expect(dec.hasLaterRequest).toHaveBeenCalledWith(conn, 12, 7);
  });

  it("skips one whose job has been closed or archived, or has gone", async () => {
    for (const job of [{ ...JOB, status: "Done" }, { ...JOB, isArchived: true }, null]) {
      jest.clearAllMocks();
      world.events = [];
      world.job = job;
      expect(await run()).toBe("skipped");
      skippedWithNothingWritten();
    }
  });

  it("skips one whose original request cannot be read", async () => {
    world.original = null;
    expect(await run()).toBe("skipped");
    skippedWithNothingWritten();
  });

  it("re-checks all of it under the job's lock: the job is locked before the deferral, and the deferral is read for update", async () => {
    await run();
    expect(store.lockJob.mock.invocationCallOrder[0]).toBeLessThan(dec.getDecisionRow.mock.invocationCallOrder[0]);
    expect(dec.getDecisionRow).toHaveBeenCalledWith(conn, 4, { forUpdate: true });
  });

  it("gives up, rolled back, if another sweep stamped the deferral first (the stamp finds it already set)", async () => {
    world.stamped = false;
    expect(await run()).toBe("skipped");
    expect(world.events).toEqual(["begin", "insert request", "stamp", "rollback"]);
    expect(raise).not.toHaveBeenCalled();
    expect(ledger).not.toHaveBeenCalled();
  });

  it("gives up, rolled back, if the job already has a decision being chased", async () => {
    world.raised = false;
    expect(await run()).toBe("skipped");
    expect(world.events).toEqual(["begin", "insert request", "stamp", "raise", "rollback"]);
    expect(ledger).not.toHaveBeenCalled();
    expect(world.events).not.toContain("announce");
  });

  it("gives up if the unique indexes say a pending request or a re-ask is there already (another sweep got in first)", async () => {
    world.insertError = Object.assign(new Error("Cannot insert duplicate key row in object 'dbo.JobDecisionRequests' with unique index 'UX_JobDecisionRequests_Pending'."), { number: 2601 });
    expect(await run()).toBe("skipped");
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(raise).not.toHaveBeenCalled();
  });
});

describe("one transaction", () => {
  it("rolls everything back, and emails no one, when the ledger row fails", async () => {
    ledger.mockRejectedValueOnce(new Error("ledger unavailable"));

    await expect(run()).rejects.toThrow("ledger unavailable");

    expect(world.events).toEqual(["begin", "insert request", "stamp", "raise", "rollback"]);
  });

  it("rolls everything back when the chase cannot be raised, including when the policy is switched off", async () => {
    raise.mockRejectedValueOnce(Object.assign(new Error('The escalation policy "job.decision_pending" is switched off'), { code: "policy_inactive" }));

    await expect(run()).rejects.toThrow("switched off");

    expect(world.events).toEqual(["begin", "insert request", "stamp", "rollback"]);
  });

  it("does not hide the failure behind a failure of the rollback", async () => {
    ledger.mockRejectedValueOnce(new Error("ledger unavailable"));
    db.rollbackTransaction.mockRejectedValueOnce(new Error("connection lost"));
    await expect(run()).rejects.toThrow("ledger unavailable");
  });
});
