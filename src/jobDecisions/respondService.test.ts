/// <reference types="jest" />
// Answering a decision request as one transaction (jobs plan A2). The store, the
// escalation engine and the ledger are replaced by an in-memory stand-in, because
// they have their own tests: what is proved here is the order of the writes, what
// each is given, that they commit or roll back together, and that nothing is
// emailed before the commit.
import type { Connection } from "tedious";
import { raiseWithin, resolveWithin } from "../escalation/engine";
import { getPolicy } from "../escalation/policies";
import { findLiveEscalation, listActiveUsers } from "../escalation/store";
import type { DirectoryUser, EscalationPolicy, EscalationRow } from "../escalation/types";
import { record } from "../ledger";
import { recordRefusal } from "../ledger/refusals";
import { isTestJob } from "../testRecords";
import * as decisions from "./decisionsStore";
import type { DecisionRow } from "./decisionsStore";
import { RequestError } from "./request";
import { parseRespondBody } from "./respond";
import { respondDecision, type RespondContext } from "./respondService";
import type { UserActor } from "./service";
import * as requests from "./store";
import type { DecisionRequestRow } from "./store";

jest.mock("../db", () => ({
  beginTransaction: jest.fn(),
  commitTransaction: jest.fn(),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn(),
}));
jest.mock("../ledger", () => ({ ...jest.requireActual("../ledger"), record: jest.fn() }));
jest.mock("../ledger/refusals", () => ({ recordRefusal: jest.fn() }));
jest.mock("../testRecords", () => ({ isTestJob: jest.fn() }));
jest.mock("../escalation/engine", () => ({ SWEEP_ACTOR: { kind: "system", name: "escalationSweepTimer" }, raiseWithin: jest.fn(), resolveWithin: jest.fn(), withdrawWithin: jest.fn() }));
jest.mock("../escalation/policies", () => ({ getPolicy: jest.fn() }));
jest.mock("../escalation/store", () => ({ ...jest.requireActual("../escalation/store"), findLiveEscalation: jest.fn(), listActiveUsers: jest.fn() }));
jest.mock("./store", () => ({ ...jest.requireActual("./store"), getRequestRow: jest.fn(), lockJob: jest.fn() }));
jest.mock("./decisionsStore", () => ({
  activeUserIdByOid: jest.fn(),
  closeNextStep: jest.fn(),
  decisionForRequest: jest.fn(),
  getDecisionRow: jest.fn(),
  insertDecision: jest.fn(),
  insertJobEvent: jest.fn(),
  jobParties: jest.fn(),
  markRequestAnswered: jest.fn(),
  openNextSteps: jest.fn(),
  reassignJob: jest.fn(),
}));

const db = require("../db") as { beginTransaction: jest.Mock; commitTransaction: jest.Mock; rollbackTransaction: jest.Mock };
const ledger = jest.mocked(record);
const refusal = jest.mocked(recordRefusal);
const testJobOf = jest.mocked(isTestJob);
const raise = jest.mocked(raiseWithin);
const resolveEscalation = jest.mocked(resolveWithin);
const policyOf = jest.mocked(getPolicy);
const liveOf = jest.mocked(findLiveEscalation);
const usersOf = jest.mocked(listActiveUsers);
const store = requests as unknown as { getRequestRow: jest.Mock; lockJob: jest.Mock };
const dec = decisions as unknown as Record<string, jest.Mock>;

const conn = {} as Connection;
// Monday 2026-10-12, 09:00 Darwin
const NOW = new Date(Date.UTC(2026, 9, 12, 9, 0) - 9.5 * 3_600_000);
const VERSION = Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]).toString("base64");
const OTHER_VERSION = Buffer.from([0, 0, 0, 0, 0, 0, 0, 2]).toString("base64");

const user = (userId: number, name: string, role: string): DirectoryUser => ({ email: `${name.toLowerCase()}@example.com`, name, role, userId });
const CAM = user(3, "Cam", "accounts_manager");
const KIRSTIN = user(4, "Kirstin", "accounts_manager");
const DEE = user(5, "Dee", "director");
const ELI = user(6, "Eli", "director");
const FAY = user(8, "Fay", "facilities");
const ALANA = user(9, "Alana", "accounts");
const GUS = user(10, "Gus", "accounts");
const UNA = user(20, "Una", "user");
const USERS = [CAM, KIRSTIN, DEE, ELI, FAY, ALANA, GUS, UNA];

const actorOf = (u: DirectoryUser): UserActor => ({ kind: "user", name: u.name, role: u.role, userId: u.userId });
const as = (u: DirectoryUser, over: Partial<RespondContext> = {}): RespondContext => ({ actor: actorOf(u), now: NOW, roles: [u.role], ...over });

const POLICY: EscalationPolicy = {
  active: true,
  autoReescalate: "yes",
  clock: "business",
  kind: "attention",
  ladder: [{ userTarget: true }, { slaHours: 16, token: "raiser_manager" }, { role: "director" }],
  policyKey: "job.next_step",
  updatedAt: null,
  updatedBy: null,
  urgent: false,
};

const request = (over: Partial<DecisionRequestRow> = {}): DecisionRequestRow => ({
  assignmentMode: "named",
  autoEscalate: true,
  decisionMakers: { role: null, userIds: [CAM.userId, DEE.userId] },
  jobId: 12,
  question: "Pay the superseded lighting invoice?",
  requestId: 7,
  requestedAt: new Date("2026-10-09T00:00:00Z"),
  requestedBy: "Alana",
  requestedByUserId: ALANA.userId,
  respondBy: new Date("2026-10-19T07:30:00Z"),
  routineWeeks: null,
  rowVersion: VERSION,
  sourceAttachmentId: null,
  state: "pending",
  tier: "soon",
  withdrawnAt: null,
  withdrawnBy: null,
  withdrawnByUserId: null,
  withdrawnReason: null,
  ...over,
});

const JOB = { buildingId: 5, buildingName: "25 Temira Crescent", isArchived: false, jobId: 12, kind: "admin", status: "New", title: "Superseded lighting invoice" };

const decisionRow = (over: Partial<DecisionRow> = {}): DecisionRow => ({
  decisionId: 4,
  deferUntil: null,
  jobId: 12,
  nextStep: "Pay the invoice",
  nextStepClosed: null,
  nextStepDueAt: new Date("2026-10-19T07:30:00Z"),
  nextStepOwnerRole: null,
  nextStepOwnerUserId: ALANA.userId,
  outcome: "approve",
  rationale: "Ordered twice",
  reaskRequestId: null,
  requestId: 7,
  respondedAt: NOW,
  respondedById: CAM.userId,
  respondedByName: "Cam",
  rowVersion: VERSION,
  ...over,
});

const escalationRow = (over: Partial<EscalationRow> = {}): EscalationRow =>
  ({ buildingId: 5, context: null, escalationId: 100, kind: "authority", level: 1, policyKey: "job.decision_pending", status: "open", subjectId: "12", subjectType: "job", ...over }) as EscalationRow;

const NEXT_STEP_ROW = escalationRow({ escalationId: 101, kind: "attention", policyKey: "job.next_step" });

const input = (over: Record<string, unknown> = {}) =>
  parseRespondBody({ nextStep: "Pay the invoice", outcome: "approve", rationale: "Ordered twice", requestId: 7, rowVersion: VERSION, ...over });

interface World {
  decisionIdNext: number;
  events: string[];
  insertError: Error | null;
  inserted: DecisionRow | null;
  live: EscalationRow | null;
  liveStep: EscalationRow | null;
  open: DecisionRow[];
  parties: { assignedTo: string | null; assignedToUserId: number | null; createdBy: string | null; createdById: string | null } | null;
  request: DecisionRequestRow | null;
  answered: DecisionRow | null;
  job: typeof JOB | null;
  oids: Record<string, number>;
}
let world: World;

beforeEach(() => {
  jest.clearAllMocks();
  world = {
    answered: null,
    decisionIdNext: 4,
    events: [],
    insertError: null,
    inserted: null,
    job: { ...JOB },
    live: escalationRow(),
    liveStep: null,
    oids: { "oid-alana": ALANA.userId },
    open: [],
    parties: { assignedTo: "Fay", assignedToUserId: FAY.userId, createdBy: "Alana", createdById: "oid-alana" },
    request: request(),
  };
  usersOf.mockResolvedValue(USERS);
  testJobOf.mockResolvedValue(false);
  policyOf.mockResolvedValue(POLICY);
  store.lockJob.mockImplementation(async () => world.job);
  store.getRequestRow.mockImplementation(async () => (world.request ? { ...world.request } : null));
  liveOf.mockImplementation((async (_c: unknown, _type: string, _id: string, policy: string) => (policy === "job.decision_pending" ? world.live : world.liveStep)) as never);
  dec.jobParties.mockImplementation(async () => world.parties);
  dec.activeUserIdByOid.mockImplementation(async (_c: unknown, oid: string) => world.oids[oid] ?? null);
  dec.insertDecision.mockImplementation(async (_c: unknown, d: Record<string, unknown>) => {
    world.events.push("insert decision");
    if (world.insertError) throw world.insertError;
    world.inserted = decisionRow({
      deferUntil: (d.deferUntil as string | null) ?? null,
      nextStep: (d.nextStep as string | null) ?? null,
      nextStepDueAt: (d.nextStepDueAt as Date | null) ?? null,
      nextStepOwnerRole: (d.nextStepOwnerRole as string | null) ?? null,
      nextStepOwnerUserId: (d.nextStepOwnerUserId as number | null) ?? null,
      outcome: d.outcome as DecisionRow["outcome"],
      rationale: d.rationale as string,
      respondedById: d.respondedById as number | null,
      respondedByName: d.respondedByName as string,
    });
    return world.decisionIdNext;
  });
  dec.getDecisionRow.mockImplementation(async () => world.inserted);
  dec.decisionForRequest.mockImplementation(async () => world.answered);
  dec.markRequestAnswered.mockImplementation(async () => {
    world.events.push("mark answered");
    return true;
  });
  dec.openNextSteps.mockImplementation(async () => [...(world.inserted && world.inserted.nextStep !== null ? [world.inserted] : []), ...world.open]);
  dec.closeNextStep.mockImplementation(async (_c: unknown, id: number) => {
    world.events.push(`close step ${id}`);
    return true;
  });
  dec.reassignJob.mockImplementation(async () => {
    world.events.push("reassign");
  });
  dec.insertJobEvent.mockImplementation(async (_c: unknown, event: { eventType: string }) => {
    world.events.push(`event:${event.eventType}`);
  });
  db.beginTransaction.mockImplementation(async () => world.events.push("begin"));
  db.commitTransaction.mockImplementation(async () => world.events.push("commit"));
  db.rollbackTransaction.mockImplementation(async () => world.events.push("rollback"));
  ledger.mockImplementation(async (_c, entry) => {
    world.events.push(`ledger:${entry.action}`);
  });
  resolveEscalation.mockImplementation((async (_c: unknown, args: { escalationId: number }) => {
    world.events.push(`resolve ${args.escalationId}`);
    return escalationRow({ escalationId: args.escalationId, status: "resolved" });
  }) as never);
  raise.mockImplementation((async () => {
    world.events.push("raise");
    return {
      announce: async () => {
        world.events.push("announce");
        return NEXT_STEP_ROW;
      },
      created: true,
      escalation: NEXT_STEP_ROW,
    };
  }) as never);
});

const writes = () => world.events.filter((e) => !["begin", "commit", "rollback"].includes(e));
const refused = async (run: () => Promise<unknown>): Promise<RequestError> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof RequestError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
};
const nothingWritten = () => {
  expect(writes().filter((e) => e !== "announce")).toEqual([]);
  expect(ledger).not.toHaveBeenCalled();
  expect(raise).not.toHaveBeenCalled();
  expect(resolveEscalation).not.toHaveBeenCalled();
};

// ── The answer, as one transaction ───────────────────────────────────────────

describe("respondDecision: approving", () => {
  it("does everything in one transaction, in order, and emails only after the commit", async () => {
    const outcome = await respondDecision(conn, as(CAM), input());

    expect(world.events).toEqual([
      "begin",
      "insert decision",
      "mark answered",
      "ledger:decision.approve",
      "resolve 100",
      "reassign",
      "event:assignment_change",
      "event:decision",
      "raise",
      "commit",
      "announce",
    ]);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
    expect(outcome.decision).toMatchObject({ decisionId: 4, outcome: "approve", respondedByName: "Cam" });
    expect(outcome.chase).toBe(NEXT_STEP_ROW);
    expect(outcome.replaced).toEqual([]);
    expect(outcome.job).toEqual({ assignedTo: "Alana", assignedToUserId: ALANA.userId, jobId: 12 });
  });

  it("writes the decision with the outcome, the rationale, who and when, and the step with its owner (the creator by default) and due moment", async () => {
    await respondDecision(conn, as(CAM), input({ rationale: "  Ordered twice  " }));

    expect(dec.insertDecision).toHaveBeenCalledWith(conn, {
      deferUntil: null,
      jobId: 12,
      nextStep: "Pay the invoice",
      nextStepDueAt: new Date("2026-10-19T07:30:00Z"), // soon: a week from Monday, 17:00 Darwin
      nextStepOwnerRole: null,
      nextStepOwnerUserId: ALANA.userId,
      outcome: "approve",
      rationale: "Ordered twice",
      requestId: 7,
      respondedAt: NOW,
      respondedById: CAM.userId,
      respondedByName: "Cam",
    });
    expect(dec.markRequestAnswered).toHaveBeenCalledWith(conn, 7, VERSION);
  });

  it("ledgers decision.approve on the job with the rationale as the reason, the decision as 'after' and the request as 'before'", async () => {
    await respondDecision(conn, as(CAM), input());

    expect(ledger).toHaveBeenCalledTimes(1);
    const entry = ledger.mock.calls[0][1];
    expect(entry).toMatchObject({
      action: "decision.approve",
      actor: actorOf(CAM),
      buildingId: 5,
      jobId: 12,
      reason: "Ordered twice",
      ruleApplied: "responder.named",
      subject: { id: 12, type: "job" },
    });
    expect(entry.after).toMatchObject({
      answeredAs: "named",
      decisionId: 4,
      nextStep: { dueAt: "2026-10-19T07:30:00.000Z", ownerUserId: ALANA.userId, text: "Pay the invoice" },
      nextStepChased: true,
      nextStepOwner: { kind: "user", name: "Alana" },
      outcome: "approve",
      rationale: "Ordered twice",
      requestId: 7,
    });
    expect(entry.before).toMatchObject({ requestId: 7, state: "pending", tier: "soon" });
  });

  it("ends the request's chase with the outcome as its code and the rationale as its note, under the ledger row's correlation id", async () => {
    await respondDecision(conn, as(CAM), input());

    const [, args] = resolveEscalation.mock.calls[0];
    expect(args).toMatchObject({ actor: actorOf(CAM), escalationId: 100, note: "Ordered twice", now: NOW, resolutionCode: "approve" });
    expect(args.correlationId).toBe(ledger.mock.calls[0][1].correlationId);
    expect(args.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("hands the job to the owner, with a line in its history, and records the decision there too", async () => {
    await respondDecision(conn, as(CAM), input());

    expect(dec.reassignJob).toHaveBeenCalledWith(conn, 12, { name: "Alana", userId: ALANA.userId });
    expect(dec.insertJobEvent).toHaveBeenNthCalledWith(1, conn, {
      createdBy: "Cam",
      eventType: "assignment_change",
      jobId: 12,
      newAssignee: "Alana",
      text: "Reassigned to Alana (was Fay)",
    });
    expect(dec.insertJobEvent).toHaveBeenNthCalledWith(2, conn, {
      createdBy: "Cam",
      eventType: "decision",
      jobId: 12,
      text: "Approved by Cam: Ordered twice\nNext step for Alana, due 19/10/2026: Pay the invoice",
    });
  });

  it("does not reassign a job that is already the owner's, but still records the decision", async () => {
    world.parties = { ...world.parties!, assignedTo: "Alana", assignedToUserId: ALANA.userId };

    await respondDecision(conn, as(CAM), input());

    expect(dec.reassignJob).not.toHaveBeenCalled();
    expect(world.events).toEqual(expect.arrayContaining(["event:decision"]));
    expect(world.events).not.toContain("event:assignment_change");
  });

  it("raises the next step for the owner: due when the tier says, urgent as the tier is, chased through their manager, with what the email needs", async () => {
    await respondDecision(conn, as(CAM), input({ rationale: "Ordered twice" }));

    expect(raise).toHaveBeenCalledTimes(1);
    const [connection, args] = raise.mock.calls[0];
    expect(connection).toBe(conn);
    expect(args).toMatchObject({
      actor: actorOf(CAM),
      dueAt: new Date("2026-10-19T07:30:00Z"),
      headline: "Next step: Pay the invoice",
      ladderRaiser: { role: "accounts", userId: ALANA.userId },
      note: "Pay the invoice",
      now: NOW,
      policyKey: "job.next_step",
      subjectId: "12",
      subjectType: "job",
      urgent: false,
      userTargets: [ALANA.userId],
    });
    expect(args.notify).toEqual({ attempts: 1 });
    expect(args.context).toEqual({
      nextStep: {
        decisionId: 4,
        dueAt: "2026-10-19T07:30:00.000Z",
        jobLabel: "Job #12 · Superseded lighting invoice · 25 Temira Crescent",
        nextStep: "Pay the invoice",
        outcome: "approve",
        ownerRole: null,
        ownerUserId: ALANA.userId,
        rationale: "Ordered twice",
        requestId: 7,
        respondedBy: "Cam",
      },
      schedule: { escalateAt: "2026-10-19T07:30:00.000Z", remindAt: ["2026-10-15T23:00:00.000Z"] },
    });
    expect(args.correlationId).toBe(ledger.mock.calls[0][1].correlationId);
  });

  it("gives the step the urgency of the request it follows: by tomorrow, urgent, and moving up whatever the asker ticked", async () => {
    world.request = request({ autoEscalate: false, tier: "urgent" });

    await respondDecision(conn, as(CAM), input());

    const [, args] = raise.mock.calls[0];
    expect(args.urgent).toBe(true);
    expect(args.dueAt).not.toBeNull();
    expect(dec.insertDecision.mock.calls[0][1].nextStepDueAt).toEqual(new Date("2026-10-13T07:30:00Z")); // close of business tomorrow
    expect(args.dueAt?.getTime()).toBeGreaterThan(new Date("2026-10-13T07:30:00Z").getTime()); // and moves up the next business morning
  });

  it("emails the owner only through the announce the engine handed back, and passes the caller's send options on", async () => {
    await respondDecision(conn, as(CAM, { notify: { attempts: 3 } }), input());
    expect(raise.mock.calls[0][1].notify).toEqual({ attempts: 3 });
  });

  it("returns the request, answered, and everyone it names", async () => {
    store.getRequestRow.mockImplementation(async () => ({ ...world.request!, state: world.events.includes("commit") ? "answered" : "pending" }));
    const outcome = await respondDecision(conn, as(CAM), input());
    expect(outcome.request.state).toBe("answered");
    expect(outcome.users).toEqual(USERS);
  });
});

// ── Who the step goes to ─────────────────────────────────────────────────────

describe("the next step's owner", () => {
  it("is the person named", async () => {
    await respondDecision(conn, as(CAM), input({ nextStepOwner: { userId: FAY.userId } }));

    expect(dec.insertDecision.mock.calls[0][1]).toMatchObject({ nextStepOwnerRole: null, nextStepOwnerUserId: FAY.userId });
    expect(raise.mock.calls[0][1]).toMatchObject({ ladderRaiser: { role: "facilities", userId: FAY.userId }, userTargets: [FAY.userId] });
    expect(dec.reassignJob).not.toHaveBeenCalled(); // Fay already has the job
  });

  it("may be the person answering: a decision-maker who will do it themselves", async () => {
    await respondDecision(conn, as(CAM), input({ nextStepOwner: { userId: CAM.userId } }));

    expect(raise.mock.calls[0][1]).toMatchObject({ actor: actorOf(CAM), ladderRaiser: { role: "accounts_manager", userId: CAM.userId }, userTargets: [CAM.userId] });
    expect(dec.reassignJob).toHaveBeenCalledWith(conn, 12, { name: "Cam", userId: CAM.userId });
  });

  it("may be a whole role: everyone in it is told, the job takes the role's label with no person, and the role's own manager is above them", async () => {
    await respondDecision(conn, as(CAM), input({ nextStepOwner: { role: "accounts" } }));

    expect(dec.insertDecision.mock.calls[0][1]).toMatchObject({ nextStepOwnerRole: "accounts", nextStepOwnerUserId: null });
    expect(raise.mock.calls[0][1]).toMatchObject({ ladderRaiser: { role: "accounts", userId: null }, userTargets: [ALANA.userId, GUS.userId] });
    expect(dec.reassignJob).toHaveBeenCalledWith(conn, 12, { name: "Accounts", userId: null });
    expect(dec.insertJobEvent.mock.calls[0][1]).toMatchObject({ newAssignee: "Accounts", text: "Reassigned to Accounts (was Fay)" });
    expect(raise.mock.calls[0][1].context).toMatchObject({ nextStep: { ownerRole: "accounts", ownerUserId: null } });
  });

  it("is the job's creator, found by their Entra id, when none is named", async () => {
    await respondDecision(conn, as(CAM), input());
    expect(dec.activeUserIdByOid).toHaveBeenCalledWith(conn, "oid-alana");
    expect(dec.insertDecision.mock.calls[0][1].nextStepOwnerUserId).toBe(ALANA.userId);
  });

  it("is the creator found by name on a job made before creators were recorded, but only if exactly one person has that name", async () => {
    world.parties = { assignedTo: null, assignedToUserId: null, createdBy: " alana ", createdById: null };
    await respondDecision(conn, as(CAM), input());
    expect(dec.activeUserIdByOid).not.toHaveBeenCalled();
    expect(dec.insertDecision.mock.calls[0][1].nextStepOwnerUserId).toBe(ALANA.userId);

    jest.clearAllMocks();
    world.events = [];
    usersOf.mockResolvedValue([...USERS, user(30, "Alana", "facilities")]);
    expect((await refused(() => respondDecision(conn, as(CAM), input()))).code).toBe("next_step_owner_required");
    nothingWritten();
  });

  it("is not guessed when the creator has left (an Entra id that matches no active user): 422 next_step_owner_required, nothing written", async () => {
    world.oids = {};
    const error = await refused(() => respondDecision(conn, as(CAM), input()));

    expect(error).toMatchObject({ code: "next_step_owner_required", status: 422 });
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    nothingWritten();
  });

  it.each([
    ["someone who is not an active user", { userId: 99 }, "next_step_owner_unknown"],
    ["someone who could never see it", { userId: UNA.userId }, "next_step_owner_role_not_allowed"],
    ["a role nobody holds", { role: "cfo" }, "next_step_owner_role_empty"],
  ])("refuses %s (422), writing nothing", async (_label, nextStepOwner, code) => {
    const error = await refused(() => respondDecision(conn, as(CAM), input({ nextStepOwner })));

    expect(error).toMatchObject({ code, status: 422 });
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    nothingWritten();
  });
});

// ── The other outcomes ───────────────────────────────────────────────────────

describe("denying", () => {
  it("is the same shape: a code of deny, a step, an owner", async () => {
    await respondDecision(conn, as(CAM), input({ nextStep: "Tell the contractor we won't pay", outcome: "deny", rationale: "Duplicate" }));

    expect(ledger.mock.calls[0][1]).toMatchObject({ action: "decision.deny", reason: "Duplicate" });
    expect(resolveEscalation.mock.calls[0][1]).toMatchObject({ resolutionCode: "deny" });
    expect(raise).toHaveBeenCalledTimes(1);
  });
});

describe("asking for revisions", () => {
  it("passes the job back to its creator with the rationale as the note: the step is theirs, and the email says what to change", async () => {
    await respondDecision(conn, as(DEE), input({ nextStep: "Correct the ABN and resubmit", outcome: "revise", rationale: "The ABN is for a different company" }));

    expect(ledger.mock.calls[0][1]).toMatchObject({ action: "decision.revise", reason: "The ABN is for a different company" });
    expect(dec.insertDecision.mock.calls[0][1]).toMatchObject({ nextStepOwnerUserId: ALANA.userId, outcome: "revise" });
    expect(dec.reassignJob).toHaveBeenCalledWith(conn, 12, { name: "Alana", userId: ALANA.userId });
    const context = raise.mock.calls[0][1].context as { nextStep: Record<string, unknown> };
    expect(context.nextStep).toMatchObject({ nextStep: "Correct the ABN and resubmit", outcome: "revise", rationale: "The ABN is for a different company", respondedBy: "Dee" });
    expect(resolveEscalation.mock.calls[0][1]).toMatchObject({ note: "The ABN is for a different company", resolutionCode: "revise" });
  });
});

describe("deferring", () => {
  it("with no step: records the decision and the day, ends the chase, and hands the job on to no one", async () => {
    await respondDecision(conn, as(CAM), input({ deferUntil: "2026-10-23", nextStep: undefined, outcome: "defer", rationale: "Wait for the corrected invoice" }));

    expect(world.events).toEqual(["begin", "insert decision", "mark answered", "ledger:decision.defer", "resolve 100", "event:decision", "commit"]);
    expect(dec.insertDecision.mock.calls[0][1]).toMatchObject({
      deferUntil: "2026-10-23",
      nextStep: null,
      nextStepDueAt: null,
      nextStepOwnerRole: null,
      nextStepOwnerUserId: null,
      outcome: "defer",
    });
    expect(raise).not.toHaveBeenCalled();
    expect(dec.reassignJob).not.toHaveBeenCalled();
    expect(dec.insertJobEvent.mock.calls[0][1].text).toBe("Deferred by Cam: Wait for the corrected invoice\nThe question comes back on 23/10/2026.");
    expect(ledger.mock.calls[0][1].after).toMatchObject({ deferUntil: "2026-10-23", nextStep: null, nextStepOwner: null, nextStepChased: null });
  });

  it("with a step: hands that on as well, and the question still comes back", async () => {
    await respondDecision(conn, as(CAM), input({ deferUntil: "2026-10-23", nextStep: "Chase the contractor for a corrected invoice", outcome: "defer" }));

    expect(raise).toHaveBeenCalledTimes(1);
    expect(dec.insertDecision.mock.calls[0][1]).toMatchObject({ deferUntil: "2026-10-23", nextStepOwnerUserId: ALANA.userId, outcome: "defer" });
  });

  it.each([
    ["today", "2026-10-12", "defer_until_past"],
    ["a day gone by", "2026-10-09", "defer_until_past"],
    ["a weekend", "2026-10-17", "defer_until_not_a_working_day"],
    ["more than a year out", "2028-01-03", "defer_until_too_far"],
  ])("refuses %s before it reads or writes anything (422)", async (_label, deferUntil, code) => {
    const error = await refused(() => respondDecision(conn, as(CAM), input({ deferUntil, nextStep: undefined, outcome: "defer" })));

    expect(error).toMatchObject({ code, status: 422 });
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(store.getRequestRow).not.toHaveBeenCalled();
  });

  it("refuses a public holiday from ESCALATION_HOLIDAYS", async () => {
    const holidays = new Set(["2026-10-14"]);
    const error = await refused(() => respondDecision(conn, as(CAM, { holidays }), input({ deferUntil: "2026-10-14", nextStep: undefined, outcome: "defer" })));
    expect(error.code).toBe("defer_until_not_a_working_day");
  });
});

// ── A step that is already open ──────────────────────────────────────────────

describe("a step an earlier decision handed on", () => {
  const older = () => decisionRow({ decisionId: 2, nextStep: "Revise the invoice", outcome: "revise", requestId: 5 });

  it("is closed as replaced, ledgered, and its chase ended, before the new one is raised", async () => {
    world.open = [older()];
    world.liveStep = escalationRow({ escalationId: 90, kind: "attention", policyKey: "job.next_step" });

    const outcome = await respondDecision(conn, as(CAM), input());

    expect(world.events).toEqual([
      "begin",
      "insert decision",
      "mark answered",
      "ledger:decision.approve",
      "resolve 100",
      "close step 2",
      "ledger:decision.next_step_replaced",
      "resolve 90",
      "reassign",
      "event:assignment_change",
      "event:decision",
      "raise",
      "commit",
      "announce",
    ]);
    expect(dec.closeNextStep).toHaveBeenCalledWith(conn, 2, { at: NOW, byId: CAM.userId, byName: "Cam", kind: "replaced", note: "Replaced by the decision of 12/10/2026" });
    expect(resolveEscalation.mock.calls[1][1]).toMatchObject({ escalationId: 90, note: "Replaced by the decision of 12/10/2026", resolutionCode: "replaced" });
    expect(ledger.mock.calls[1][1]).toMatchObject({
      action: "decision.next_step_replaced",
      after: { closedKind: "replaced", decisionId: 2, replacedBy: 4 },
      jobId: 12,
    });
    expect(ledger.mock.calls[1][1].correlationId).toBe(ledger.mock.calls[0][1].correlationId);
    expect(outcome.replaced.map((d) => d.decisionId)).toEqual([2]);
  });

  it("never replaces the step it has just handed on", async () => {
    await respondDecision(conn, as(CAM), input());
    expect(dec.closeNextStep).not.toHaveBeenCalled();
  });

  it("is left alone by a deferral that hands nothing on", async () => {
    world.open = [older()];
    world.liveStep = escalationRow({ escalationId: 90, kind: "attention", policyKey: "job.next_step" });

    await respondDecision(conn, as(CAM), input({ deferUntil: "2026-10-23", nextStep: undefined, outcome: "defer" }));

    expect(dec.closeNextStep).not.toHaveBeenCalled();
    expect(resolveEscalation).toHaveBeenCalledTimes(1);
  });

  it("is not reported as replaced if it was closed by someone else in the meantime", async () => {
    world.open = [older()];
    dec.closeNextStep.mockResolvedValueOnce(false);

    const outcome = await respondDecision(conn, as(CAM), input());

    expect(outcome.replaced).toEqual([]);
    expect(ledger.mock.calls.map(([, entry]) => entry.action)).toEqual(["decision.approve"]);
  });
});

describe("when the next step's policy is switched off", () => {
  it("still answers: the step is recorded and handed on, but not chased, and the ledger says so", async () => {
    policyOf.mockResolvedValue({ ...POLICY, active: false });

    const outcome = await respondDecision(conn, as(CAM), input());

    expect(raise).not.toHaveBeenCalled();
    expect(outcome.chase).toBeNull();
    expect(ledger.mock.calls[0][1].after).toMatchObject({ nextStepChased: false });
    expect(world.events).toEqual(expect.arrayContaining(["commit"]));
    expect(dec.reassignJob).toHaveBeenCalled();
  });

  it("is chased when the policy row is missing from the cache, as the engine itself would say so", async () => {
    policyOf.mockResolvedValue(null);
    await respondDecision(conn, as(CAM), input());
    expect(raise).toHaveBeenCalledTimes(1);
  });
});

describe("a request with no chase left to end", () => {
  it("is answered all the same", async () => {
    world.live = null;
    await respondDecision(conn, as(CAM), input());
    expect(resolveEscalation).not.toHaveBeenCalled();
    expect(world.events).toContain("commit");
  });
});

// ── Who may answer ───────────────────────────────────────────────────────────

describe("who may answer", () => {
  it("each person named may, and the ledger says it was as one of those named", async () => {
    await respondDecision(conn, as(DEE), input());
    expect(ledger.mock.calls[0][1]).toMatchObject({ actor: actorOf(DEE), ruleApplied: "responder.named" });
  });

  it("a stranger may not, even a director or an admin who was not asked: 403 with a plain reason, ledgered as denied once the transaction has rolled back", async () => {
    const error = await refused(() => respondDecision(conn, as(ELI), input({ outcome: "deny", rationale: "No" })));

    expect(error).toMatchObject({ code: "not_a_decision_maker", status: 403, details: { reason: "not_named" } });
    expect(error.message).toBe("This question was put to Cam, Dee. You weren't asked, so you can't answer it.");
    expect(world.events).toEqual(["begin", "rollback"]);
    nothingWritten();

    expect(refusal).toHaveBeenCalledTimes(1);
    expect(refusal).toHaveBeenCalledWith(
      conn,
      actorOf(ELI),
      { id: 12, type: "job" },
      { attempted: "decision.deny", code: "not_a_decision_maker", message: error.message, state: { assignmentMode: "named", requestId: 7, state: "pending", tier: "soon" } },
      12,
    );
    expect(db.rollbackTransaction.mock.invocationCallOrder[0]).toBeLessThan(refusal.mock.invocationCallOrder[0]);
  });

  it("a request put to a role is answered by whoever holds it now, including someone who joined it since", async () => {
    world.request = request({ assignmentMode: "role", decisionMakers: { role: "accounts_manager", userIds: [CAM.userId] } });

    await respondDecision(conn, as(KIRSTIN), input());

    expect(ledger.mock.calls[0][1]).toMatchObject({ actor: actorOf(KIRSTIN), ruleApplied: "responder.role" });
    expect(ledger.mock.calls[0][1].after).toMatchObject({ answeredAs: "role" });
  });

  it("and not by someone who was in the role when it was asked and has left it", async () => {
    world.request = request({ assignmentMode: "role", decisionMakers: { role: "accounts_manager", userIds: [CAM.userId, KIRSTIN.userId] } });

    const error = await refused(() => respondDecision(conn, as(KIRSTIN, { roles: ["facilities"] }), input()));

    expect(error).toMatchObject({ code: "not_a_decision_maker", details: { reason: "not_in_role" } });
    expect(refusal).toHaveBeenCalledTimes(1);
  });

  it("the person who asked never answers their own question, even holding the role it was put to", async () => {
    world.request = request({ assignmentMode: "role", decisionMakers: { role: "accounts", userIds: [GUS.userId] } });

    const error = await refused(() => respondDecision(conn, as(ALANA), input()));

    expect(error).toMatchObject({ code: "not_a_decision_maker", details: { reason: "asker" } });
    expect(error.message).toBe("You asked this question, so someone else has to answer it.");
    nothingWritten();
  });

  it("is checked before the request's state, so a stranger learns nothing from a 409", async () => {
    world.request = request({ state: "answered" });
    expect((await refused(() => respondDecision(conn, as(ELI), input()))).code).toBe("not_a_decision_maker");
  });
});

// ── Admin approves nothing real (decision 4) ─────────────────────────────────

describe("admin answering", () => {
  // Admin can no longer be asked (roles.ts), so these are requests that name one all
  // the same: written before that, or by hand.
  const ADA = user(7, "Ada", "admin");
  const asksAdmin = () => {
    usersOf.mockResolvedValue([...USERS, ADA]);
    world.request = request({ decisionMakers: { role: null, userIds: [CAM.userId, ADA.userId] } });
  };

  it("on a real job is refused: 403 in plain words, ledgered as denied once the transaction has rolled back, nothing written", async () => {
    asksAdmin();

    const error = await refused(() => respondDecision(conn, as(ADA), input()));

    expect(error).toMatchObject({ code: "not_a_decision_maker", status: 403, details: { reason: "admin_test_jobs_only" } });
    expect(error.message).toBe("Admin answers questions on test jobs only. This is a real job, so someone else has to answer it.");
    expect(world.events).toEqual(["begin", "rollback"]);
    nothingWritten();
    expect(refusal).toHaveBeenCalledTimes(1);
    expect(refusal).toHaveBeenCalledWith(
      conn,
      actorOf(ADA),
      { id: 12, type: "job" },
      { attempted: "decision.approve", code: "not_a_decision_maker", message: error.message, state: { assignmentMode: "named", requestId: 7, state: "pending", tier: "soon" } },
      12,
    );
    expect(db.rollbackTransaction.mock.invocationCallOrder[0]).toBeLessThan(refusal.mock.invocationCallOrder[0]);
    expect(testJobOf).toHaveBeenCalledWith(conn, 12);
  });

  it("on a real job is refused whatever the outcome", async () => {
    asksAdmin();
    for (const outcome of ["approve", "deny", "revise"]) {
      const error = await refused(() => respondDecision(conn, as(ADA), input({ outcome, rationale: "Fine" })));
      expect(error).toMatchObject({ code: "not_a_decision_maker", details: { reason: "admin_test_jobs_only" } });
    }
    nothingWritten();
  });

  it("put to the admin role, on a real job, is refused the same", async () => {
    usersOf.mockResolvedValue([...USERS, ADA]);
    world.request = request({ assignmentMode: "role", decisionMakers: { role: "admin", userIds: [ADA.userId] } });

    expect(await refused(() => respondDecision(conn, as(ADA), input()))).toMatchObject({ code: "not_a_decision_maker", details: { reason: "admin_test_jobs_only" } });
    nothingWritten();
  });

  it("on a test job may answer, and the ledger says it was as one of those named", async () => {
    asksAdmin();
    testJobOf.mockResolvedValue(true);

    await respondDecision(conn, as(ADA), input());

    expect(testJobOf).toHaveBeenCalledWith(conn, 12);
    expect(ledger.mock.calls[0][1]).toMatchObject({ action: "decision.approve", actor: actorOf(ADA), ruleApplied: "responder.named" });
    expect(world.events).toContain("commit");
    expect(refusal).not.toHaveBeenCalled();
  });

  it("on a test job is still only answering what was put to them", async () => {
    usersOf.mockResolvedValue([...USERS, ADA]);
    testJobOf.mockResolvedValue(true);

    expect(await refused(() => respondDecision(conn, as(ADA), input()))).toMatchObject({ details: { reason: "not_named" } });
    nothingWritten();
  });

  it("is the only answer that looks the job up: everyone else's costs no extra query", async () => {
    await respondDecision(conn, as(CAM), input());
    expect(testJobOf).not.toHaveBeenCalled();
  });
});

// ── Errors ───────────────────────────────────────────────────────────────────

describe("what cannot be answered", () => {
  it("a request that does not exist: 404, before a transaction", async () => {
    world.request = null;
    expect(await refused(() => respondDecision(conn, as(CAM), input()))).toMatchObject({ code: "not_found", status: 404 });
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });

  it("a request that vanishes between the read and the lock: 404, rolled back", async () => {
    store.getRequestRow.mockResolvedValueOnce(request()).mockResolvedValueOnce(null);
    expect(await refused(() => respondDecision(conn, as(CAM), input()))).toMatchObject({ code: "not_found", status: 404 });
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it("a job that does not exist: 404", async () => {
    world.job = null;
    expect(await refused(() => respondDecision(conn, as(CAM), input()))).toMatchObject({ code: "job_not_found", status: 404 });
    nothingWritten();
  });

  it("a question already answered: 409 not_pending, carrying the request and the answer it got", async () => {
    world.request = request({ state: "answered" });
    world.answered = decisionRow({ outcome: "deny" });

    const error = await refused(() => respondDecision(conn, as(CAM), input()));

    expect(error).toMatchObject({ code: "not_pending", message: "This question was already answered.", status: 409 });
    expect(error.details.request).toMatchObject({ requestId: 7, state: "answered" });
    expect(error.details.decision).toMatchObject({ decisionId: 4, outcome: "deny" });
    nothingWritten();
  });

  it("a question taken back: 409 not_pending, with no answer to show", async () => {
    world.request = request({ state: "withdrawn" });

    const error = await refused(() => respondDecision(conn, as(CAM), input()));

    expect(error).toMatchObject({ code: "not_pending", message: "This question was already withdrawn." });
    expect(error.details).not.toHaveProperty("decision");
    expect(dec.decisionForRequest).not.toHaveBeenCalled();
  });

  it("an answer to a question that has changed since the screen read it: 409 stale, carrying the request", async () => {
    const error = await refused(() => respondDecision(conn, as(CAM), input({ rowVersion: OTHER_VERSION })));

    expect(error).toMatchObject({ code: "stale", status: 409 });
    expect(error.details.request).toMatchObject({ rowVersion: VERSION });
    nothingWritten();
  });

  it("a request whose version changes under the answer (lost between the check and the update): 409 stale, rolled back", async () => {
    dec.markRequestAnswered.mockResolvedValueOnce(false);

    expect(await refused(() => respondDecision(conn, as(CAM), input()))).toMatchObject({ code: "stale", status: 409 });
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(ledger).not.toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("two answers at the same moment: the unique index on the decision's request lets one in; the other is a 409 not_pending", async () => {
    world.insertError = Object.assign(new Error("Cannot insert duplicate key row in object 'dbo.JobDecisions' with unique index 'UX_JobDecisions_Request'."), { number: 2601 });

    const error = await refused(() => respondDecision(conn, as(CAM), input()));

    expect(error).toMatchObject({ code: "not_pending", message: "This question was just answered by someone else.", status: 409 });
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it("any other unique violation is not mistaken for that: it surfaces as it is", async () => {
    world.insertError = Object.assign(new Error("Cannot insert duplicate key row in object 'dbo.Escalations' with unique index 'UX_Escalations_Live'."), { number: 2601 });
    await expect(respondDecision(conn, as(CAM), input())).rejects.toThrow("UX_Escalations_Live");
  });

  it("a closed job: 409 job_closed, whatever the question was", async () => {
    for (const closed of [{ status: "Done" }, { isArchived: true }]) {
      jest.clearAllMocks();
      world.events = [];
      world.job = { ...JOB, ...closed };
      const error = await refused(() => respondDecision(conn, as(CAM), input()));
      expect(error).toMatchObject({ code: "job_closed", status: 409 });
      expect(error.details.request).toMatchObject({ requestId: 7 });
      nothingWritten();
    }
  });

  it("another next step already being chased that the new one cannot take the place of: 409, rolled back, nobody emailed", async () => {
    raise.mockImplementationOnce((async () => ({ announce: async () => NEXT_STEP_ROW, created: false, escalation: NEXT_STEP_ROW })) as never);

    expect(await refused(() => respondDecision(conn, as(CAM), input()))).toMatchObject({ code: "stale", status: 409 });
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(world.events).not.toContain("announce");
  });
});

// ── Rolling back ─────────────────────────────────────────────────────────────

describe("one transaction", () => {
  it("rolls everything back and emails no one when the decision's ledger row fails", async () => {
    ledger.mockRejectedValueOnce(new Error("ledger unavailable"));

    await expect(respondDecision(conn, as(CAM), input())).rejects.toThrow("ledger unavailable");

    expect(world.events).toEqual(["begin", "insert decision", "mark answered", "rollback"]);
    expect(raise).not.toHaveBeenCalled();
    expect(refusal).not.toHaveBeenCalled();
  });

  it("rolls everything back when the next step cannot be raised, after the decision, the chase and the job were all written", async () => {
    raise.mockRejectedValueOnce(new Error("escalation unavailable"));

    await expect(respondDecision(conn, as(CAM), input())).rejects.toThrow("escalation unavailable");

    expect(world.events[world.events.length - 1]).toBe("rollback");
    expect(world.events).toEqual(expect.arrayContaining(["insert decision", "mark answered", "resolve 100", "reassign", "event:decision"]));
    expect(world.events).not.toContain("commit");
    expect(world.events).not.toContain("announce");
  });

  it("rolls everything back when the request's chase cannot be ended", async () => {
    resolveEscalation.mockRejectedValueOnce(new Error("stale"));
    await expect(respondDecision(conn, as(CAM), input())).rejects.toThrow("stale");
    expect(world.events).toEqual(["begin", "insert decision", "mark answered", "ledger:decision.approve", "rollback"]);
    expect(raise).not.toHaveBeenCalled();
  });

  it("rolls everything back when the job cannot be handed on", async () => {
    dec.reassignJob.mockRejectedValueOnce(new Error("deadlock"));
    await expect(respondDecision(conn, as(CAM), input())).rejects.toThrow("deadlock");
    expect(world.events[world.events.length - 1]).toBe("rollback");
    expect(raise).not.toHaveBeenCalled();
  });

  it("does not hide a failure of the rollback itself behind the failure that caused it", async () => {
    ledger.mockRejectedValueOnce(new Error("ledger unavailable"));
    db.rollbackTransaction.mockRejectedValueOnce(new Error("connection lost"));
    await expect(respondDecision(conn, as(CAM), input())).rejects.toThrow("ledger unavailable");
  });

  it("takes the job's lock before the request's, in the order asking takes them", async () => {
    await respondDecision(conn, as(CAM), input());
    const lockJobAt = store.lockJob.mock.invocationCallOrder[0];
    const lockedRequestAt = store.getRequestRow.mock.invocationCallOrder.find((_order, index) => store.getRequestRow.mock.calls[index][2]?.forUpdate);
    expect(store.getRequestRow.mock.calls[0][2]).toBeUndefined(); // the first read, unlocked, only to learn the job
    expect(lockJobAt).toBeGreaterThan(store.getRequestRow.mock.invocationCallOrder[0]);
    expect(lockedRequestAt).toBeGreaterThan(lockJobAt);
  });
});
