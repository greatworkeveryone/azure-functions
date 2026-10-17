/// <reference types="jest" />
// Marking a next step done as one transaction (jobs plan A2). The store, the engine
// and the job-closing path are replaced by an in-memory stand-in, because they have
// their own tests: what is proved here is who may, what is written and in what
// order, when the job is finished and when it is not (and why), and that it all
// commits or rolls back together.
import type { Connection } from "tedious";
import { resolveWithin } from "../escalation/engine";
import { findLiveEscalation, listActiveUsers } from "../escalation/store";
import type { DirectoryUser, EscalationRow } from "../escalation/types";
import { record } from "../ledger";
import { recordRefusal } from "../ledger/refusals";
import { closeInternalJobWithin } from "./closeJob";
import { completeNextStep, type CompleteContext, type CompleteInput } from "./completeService";
import * as decisions from "./decisionsStore";
import type { DecisionRow } from "./decisionsStore";
import { RequestError } from "./request";
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
jest.mock("../escalation/engine", () => ({ resolveWithin: jest.fn() }));
jest.mock("../escalation/store", () => ({ ...jest.requireActual("../escalation/store"), findLiveEscalation: jest.fn(), listActiveUsers: jest.fn() }));
jest.mock("./store", () => ({ ...jest.requireActual("./store"), findPending: jest.fn(), lockJob: jest.fn() }));
jest.mock("./closeJob", () => ({ closeInternalJobWithin: jest.fn() }));
jest.mock("./decisionsStore", () => ({
  closeNextStep: jest.fn(),
  getDecisionRow: jest.fn(),
  hasScheduledReask: jest.fn(),
  insertJobEvent: jest.fn(),
  openNextSteps: jest.fn(),
}));

const db = require("../db") as { beginTransaction: jest.Mock; commitTransaction: jest.Mock; rollbackTransaction: jest.Mock };
const ledger = jest.mocked(record);
const refusal = jest.mocked(recordRefusal);
const resolveEscalation = jest.mocked(resolveWithin);
const liveOf = jest.mocked(findLiveEscalation);
const usersOf = jest.mocked(listActiveUsers);
const closeJob = jest.mocked(closeInternalJobWithin);
const store = requests as unknown as { findPending: jest.Mock; lockJob: jest.Mock };
const dec = decisions as unknown as Record<string, jest.Mock>;

const conn = {} as Connection;
// Wednesday 2026-10-14, 10:00 Darwin
const NOW = new Date(Date.UTC(2026, 9, 14, 10, 0) - 9.5 * 3_600_000);
const VERSION = Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]).toString("base64");
const OTHER_VERSION = Buffer.from([0, 0, 0, 0, 0, 0, 0, 2]).toString("base64");

const user = (userId: number, name: string, role: string): DirectoryUser => ({ email: `${name.toLowerCase()}@example.com`, name, role, userId });
const CAM = user(3, "Cam", "accounts_manager");
const DEE = user(5, "Dee", "director");
const FAY = user(8, "Fay", "facilities");
const ALANA = user(9, "Alana", "accounts");
const GUS = user(10, "Gus", "accounts");
const USERS = [CAM, DEE, FAY, ALANA, GUS];

const actorOf = (u: DirectoryUser): UserActor => ({ kind: "user", name: u.name, role: u.role, userId: u.userId });
const as = (u: DirectoryUser, over: Partial<CompleteContext> = {}): CompleteContext => ({ actor: actorOf(u), now: NOW, roles: [u.role], ...over });
const done = (over: Partial<CompleteInput> = {}): CompleteInput => ({ decisionId: 4, note: null, rowVersion: null, ...over });

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
  respondedAt: new Date("2026-10-12T00:30:00Z"),
  respondedById: CAM.userId,
  respondedByName: "Cam",
  rowVersion: VERSION,
  ...over,
});
const CLOSED = { at: NOW, byId: ALANA.userId, byName: "Alana", kind: "done" as const, note: null };

const JOB = { buildingId: 5, buildingName: "25 Temira Crescent", isArchived: false, jobId: 12, kind: "admin", status: "Work", title: "Superseded lighting invoice" };

const stepEscalation = (decisionId = 4): EscalationRow =>
  ({ context: { nextStep: { decisionId, nextStep: "Pay the invoice" } }, escalationId: 101, kind: "attention", policyKey: "job.next_step", status: "open", subjectId: "12", subjectType: "job" }) as unknown as EscalationRow;

interface World {
  after: DecisionRow | null;
  closes: boolean;
  decision: DecisionRow | null;
  events: string[];
  job: typeof JOB | null;
  live: EscalationRow | null;
  open: DecisionRow[];
  pending: DecisionRequestRow | null;
  reask: boolean;
}
let world: World;

beforeEach(() => {
  jest.clearAllMocks();
  world = { after: null, closes: true, decision: decisionRow(), events: [], job: { ...JOB }, live: stepEscalation(), open: [], pending: null, reask: false };
  usersOf.mockResolvedValue(USERS);
  store.lockJob.mockImplementation(async () => world.job);
  store.findPending.mockImplementation(async () => world.pending);
  liveOf.mockImplementation((async () => world.live) as never);
  dec.getDecisionRow.mockImplementation(async (_c: unknown, _id: number, options?: { forUpdate?: boolean }) => {
    // The first read is the unlocked peek; once the step is closed, the next shows it closed.
    if (world.after && !options?.forUpdate && world.events.includes("close step")) return world.after;
    return world.decision ? { ...world.decision } : null;
  });
  dec.closeNextStep.mockImplementation(async () => {
    world.events.push("close step");
    world.after = decisionRow({ ...world.decision!, nextStepClosed: CLOSED });
    return true;
  });
  dec.openNextSteps.mockImplementation(async () => world.open);
  dec.hasScheduledReask.mockImplementation(async () => world.reask);
  dec.insertJobEvent.mockImplementation(async () => {
    world.events.push("event");
  });
  closeJob.mockImplementation((async () => {
    world.events.push("close job");
    return world.closes ? { closed: true } : { closed: false, code: "role_not_permitted", reason: "Your role can't make this change." };
  }) as never);
  resolveEscalation.mockImplementation((async (_c: unknown, args: { escalationId: number }) => {
    world.events.push(`resolve ${args.escalationId}`);
    return stepEscalation();
  }) as never);
  db.beginTransaction.mockImplementation(async () => world.events.push("begin"));
  db.commitTransaction.mockImplementation(async () => world.events.push("commit"));
  db.rollbackTransaction.mockImplementation(async () => world.events.push("rollback"));
  ledger.mockImplementation(async (_c, entry) => {
    world.events.push(`ledger:${entry.action}`);
  });
});

const refused = async (run: () => Promise<unknown>): Promise<RequestError> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof RequestError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
};
const writes = () => world.events.filter((e) => !["begin", "commit", "rollback"].includes(e));

describe("completeNextStep", () => {
  it("closes the step, ends its chase, writes the history and the ledger, finishes the job and commits, in that order", async () => {
    const outcome = await completeNextStep(conn, as(ALANA), done({ note: "Paid on the 14th" }));

    expect(world.events).toEqual(["begin", "close step", "resolve 101", "event", "close job", "ledger:decision.next_step_done", "commit"]);
    expect(outcome).toMatchObject({ jobClosed: true, jobId: 12, jobStaysOpen: null, jobStatus: "Done" });
    expect(outcome.decision.nextStepClosed).toMatchObject({ kind: "done" });
  });

  it("closes it as done, by whom, when and with the note", async () => {
    await completeNextStep(conn, as(ALANA), done({ note: "Paid on the 14th" }));
    expect(dec.closeNextStep).toHaveBeenCalledWith(conn, 4, { at: NOW, byId: ALANA.userId, byName: "Alana", expectedRowVersion: null, kind: "done", note: "Paid on the 14th" });
  });

  it("ends the owner's chase with a code and the note, under the ledger row's correlation id", async () => {
    await completeNextStep(conn, as(ALANA), done({ note: "Paid" }));

    const args = resolveEscalation.mock.calls[0][1];
    expect(args).toMatchObject({ actor: actorOf(ALANA), escalationId: 101, note: "Paid", now: NOW, resolutionCode: "next_step_done" });
    expect(args.correlationId).toBe(ledger.mock.calls[0][1].correlationId);
  });

  it("leaves a chase alone that belongs to a different decision's step", async () => {
    world.live = stepEscalation(99);
    await completeNextStep(conn, as(ALANA), done());
    expect(resolveEscalation).not.toHaveBeenCalled();
  });

  it("copes with a step whose chase has already gone", async () => {
    world.live = null;
    await completeNextStep(conn, as(ALANA), done());
    expect(resolveEscalation).not.toHaveBeenCalled();
    expect(world.events).toContain("commit");
  });

  it("ledgers decision.next_step_done on the job, the note as the reason and the closed decision as 'after'", async () => {
    await completeNextStep(conn, as(ALANA), done({ note: "Paid" }));

    const entry = ledger.mock.calls[0][1];
    expect(entry).toMatchObject({
      action: "decision.next_step_done",
      actor: actorOf(ALANA),
      buildingId: 5,
      jobId: 12,
      reason: "Paid",
      ruleApplied: "next_step.owner",
      subject: { id: 12, type: "job" },
    });
    expect(entry.after).toMatchObject({ doneAs: "owner", jobClosed: true, jobStaysOpen: null, nextStep: { closed: { by: "Alana", kind: "done" } } });
    expect(entry.before).toMatchObject({ decisionId: 4, nextStep: { closed: null } });
  });

  it("writes it in the job's history: who marked what done, and the note", async () => {
    await completeNextStep(conn, as(ALANA), done({ note: "Paid on the 14th" }));
    expect(dec.insertJobEvent).toHaveBeenCalledWith(conn, {
      createdBy: "Alana",
      eventType: "decision",
      jobId: 12,
      text: "Alana marked the next step done: Pay the invoice\nPaid on the 14th",
    });
  });

  it("takes an optional version and passes it on, so a stale screen is a 409", async () => {
    await completeNextStep(conn, as(ALANA), done({ rowVersion: VERSION }));
    expect(dec.closeNextStep.mock.calls[0][2].expectedRowVersion).toBe(VERSION);

    jest.clearAllMocks();
    world.events = [];
    const error = await refused(() => completeNextStep(conn, as(ALANA), done({ rowVersion: OTHER_VERSION })));
    expect(error).toMatchObject({ code: "stale", status: 409 });
    expect(error.details.decision).toMatchObject({ decisionId: 4 });
    expect(dec.closeNextStep).not.toHaveBeenCalled();
  });

  it("is a 409 stale if the step is closed between the check and the write", async () => {
    dec.closeNextStep.mockResolvedValueOnce(false);
    expect(await refused(() => completeNextStep(conn, as(ALANA), done()))).toMatchObject({ code: "stale", status: 409 });
    expect(world.events).toEqual(["begin", "rollback"]);
  });

  it("takes the job's lock before the decision's", async () => {
    await completeNextStep(conn, as(ALANA), done());
    const peek = dec.getDecisionRow.mock.invocationCallOrder[0];
    const lockedAt = dec.getDecisionRow.mock.invocationCallOrder.find((_o, i) => dec.getDecisionRow.mock.calls[i][2]?.forUpdate);
    expect(dec.getDecisionRow.mock.calls[0][2]).toBeUndefined();
    expect(store.lockJob.mock.invocationCallOrder[0]).toBeGreaterThan(peek);
    expect(lockedAt).toBeGreaterThan(store.lockJob.mock.invocationCallOrder[0]);
  });
});

describe("who may finish a step", () => {
  it("the person it was handed to", async () => {
    await completeNextStep(conn, as(ALANA), done());
    expect(ledger.mock.calls[0][1]).toMatchObject({ ruleApplied: "next_step.owner" });
  });

  it("anyone in the role it was handed to, now", async () => {
    world.decision = decisionRow({ nextStepOwnerRole: "accounts", nextStepOwnerUserId: null });
    await completeNextStep(conn, as(GUS), done());
    expect(ledger.mock.calls[0][1]).toMatchObject({ actor: actorOf(GUS), ruleApplied: "next_step.role" });
  });

  it.each([
    ["an accounts manager", CAM],
    ["a director", DEE],
  ])("%s, as a manager and above, whoever it was handed to", async (_label, manager) => {
    await completeNextStep(conn, as(manager), done());
    expect(ledger.mock.calls[0][1]).toMatchObject({ actor: actorOf(manager), ruleApplied: "next_step.manager" });
  });

  it("a colleague of the owner's, at the owner's level, may not: 403 naming whose it is, ledgered as denied after the rollback", async () => {
    const error = await refused(() => completeNextStep(conn, as(GUS), done()));

    expect(error).toMatchObject({ code: "not_next_step_owner", status: 403 });
    expect(error.message).toBe("This step was handed to Alana. Only they, or a manager, can mark it done.");
    expect(world.events).toEqual(["begin", "rollback"]);
    expect(ledger).not.toHaveBeenCalled();
    expect(dec.closeNextStep).not.toHaveBeenCalled();

    expect(refusal).toHaveBeenCalledTimes(1);
    expect(refusal).toHaveBeenCalledWith(
      conn,
      actorOf(GUS),
      { id: 12, type: "job" },
      { attempted: "decision.next_step_done", code: "not_next_step_owner", message: error.message, state: { decisionId: 4, outcome: "approve" } },
      12,
    );
    expect(db.rollbackTransaction.mock.invocationCallOrder[0]).toBeLessThan(refusal.mock.invocationCallOrder[0]);
  });

  it("a facilities person with no connection to the step may not", async () => {
    expect((await refused(() => completeNextStep(conn, as(FAY), done()))).code).toBe("not_next_step_owner");
  });

  it("is checked before the step's state, so a stranger learns nothing from a 409", async () => {
    world.decision = decisionRow({ nextStepClosed: CLOSED });
    expect((await refused(() => completeNextStep(conn, as(GUS), done()))).code).toBe("not_next_step_owner");
  });
});

describe("what cannot be finished", () => {
  it("a decision that does not exist: 404, before a transaction", async () => {
    world.decision = null;
    expect(await refused(() => completeNextStep(conn, as(ALANA), done()))).toMatchObject({ code: "not_found", status: 404 });
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });

  it("a decision that vanishes between the read and the lock: 404", async () => {
    dec.getDecisionRow.mockResolvedValueOnce(decisionRow()).mockResolvedValueOnce(null);
    expect(await refused(() => completeNextStep(conn, as(ALANA), done()))).toMatchObject({ code: "not_found", status: 404 });
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it("a job that does not exist: 404", async () => {
    world.job = null;
    expect(await refused(() => completeNextStep(conn, as(ALANA), done()))).toMatchObject({ code: "job_not_found", status: 404 });
  });

  it("a deferral that handed on no step: 409 no_next_step, carrying the decision", async () => {
    world.decision = decisionRow({ deferUntil: "2026-10-23", nextStep: null, nextStepDueAt: null, nextStepOwnerUserId: null, outcome: "defer" });

    const error = await refused(() => completeNextStep(conn, as(CAM), done()));

    expect(error).toMatchObject({ code: "no_next_step", status: 409 });
    expect(error.details.decision).toMatchObject({ outcome: "defer" });
    expect(dec.closeNextStep).not.toHaveBeenCalled();
  });

  it("a step already done: 409 already_done, naming who did it, carrying the decision", async () => {
    world.decision = decisionRow({ nextStepClosed: { ...CLOSED, byName: "Cam" } });

    const error = await refused(() => completeNextStep(conn, as(ALANA), done()));

    expect(error).toMatchObject({ code: "already_done", message: "This step was already marked done by Cam.", status: 409 });
    expect(error.details.decision).toMatchObject({ decisionId: 4 });
    expect(world.events).toEqual(["begin", "rollback"]);
  });

  it("a step a later decision took over: 409 step_replaced", async () => {
    world.decision = decisionRow({ nextStepClosed: { ...CLOSED, kind: "replaced" } });
    expect(await refused(() => completeNextStep(conn, as(ALANA), done()))).toMatchObject({ code: "step_replaced", status: 409 });
  });
});

describe("whether the job is finished", () => {
  const completing = (decision: Partial<DecisionRow>, who: DirectoryUser = ALANA) => {
    world.decision = decisionRow(decision);
    return completeNextStep(conn, as(who), done());
  };

  it("an approved step finishes the job, through the in-house close path, as the person who did it, with a history line", async () => {
    const outcome = await completing({ outcome: "approve" });

    expect(closeJob).toHaveBeenCalledWith(conn, { actorName: "Alana", jobId: 12, roles: ["accounts"], text: "Next step done: Pay the invoice" });
    expect(outcome).toMatchObject({ jobClosed: true, jobStaysOpen: null, jobStatus: "Done" });
  });

  it("a denied step finishes it too, and the note goes in the history line", async () => {
    world.decision = decisionRow({ outcome: "deny" });
    await completeNextStep(conn, as(ALANA), done({ note: "Told the contractor" }));
    expect(closeJob.mock.calls[0][1].text).toBe("Next step done: Pay the invoice (Told the contractor)");
  });

  it("a revision does NOT: the creator is expected to ask again", async () => {
    const outcome = await completing({ outcome: "revise" });

    expect(closeJob).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ jobClosed: false, jobStaysOpen: "revise", jobStatus: "Work" });
    expect(world.events).toContain("commit");
  });

  it("a deferral's step does NOT: the question is still to come back", async () => {
    const outcome = await completing({ deferUntil: "2026-10-23", outcome: "defer" });
    expect(closeJob).not.toHaveBeenCalled();
    expect(outcome.jobStaysOpen).toBe("deferred");
  });

  it("nothing finishes it while a question is waiting for an answer", async () => {
    world.pending = { requestId: 9, state: "pending" } as DecisionRequestRow;
    const outcome = await completing({});
    expect(closeJob).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ jobClosed: false, jobStaysOpen: "pending_request" });
  });

  it("nor while another step is still open", async () => {
    world.open = [decisionRow({ decisionId: 6 })];
    const outcome = await completing({});
    expect(closeJob).not.toHaveBeenCalled();
    expect(outcome.jobStaysOpen).toBe("other_step");
  });

  it("nor while a deferral is waiting for its day", async () => {
    world.reask = true;
    const outcome = await completing({});
    expect(closeJob).not.toHaveBeenCalled();
    expect(outcome.jobStaysOpen).toBe("deferred");
  });

  it("a job that is closed already stays as it is, and the step is still marked done", async () => {
    world.job = { ...JOB, status: "Done" };
    const outcome = await completing({});
    expect(closeJob).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ jobClosed: false, jobStaysOpen: "already_closed", jobStatus: "Done" });
    expect(world.events).toContain("close step");

    world.job = { ...JOB, isArchived: true };
    expect((await completing({})).jobStaysOpen).toBe("already_closed");
  });

  it("only an Admin / Accounts job is finished by a decision's step", async () => {
    world.job = { ...JOB, kind: "facilities" };
    const outcome = await completing({});
    expect(closeJob).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ jobClosed: false, jobStaysOpen: "refused" });
    expect(outcome.jobStaysOpenReason).toMatch(/Admin \/ Accounts/);
  });

  it("when the close path refuses, the step is still done, the job stays open, and the reason is passed on", async () => {
    world.closes = false;
    const outcome = await completing({});

    expect(outcome).toMatchObject({ jobClosed: false, jobStaysOpen: "refused", jobStaysOpenReason: "Your role can't make this change.", jobStatus: "Work" });
    expect(world.events).toEqual(expect.arrayContaining(["close step", "close job", "ledger:decision.next_step_done", "commit"]));
    expect(ledger.mock.calls[0][1].after).toMatchObject({ jobClosed: false, jobStaysOpen: "refused" });
  });

  it("a manager finishing someone else's step finishes the job, as themselves", async () => {
    await completing({}, DEE);
    expect(closeJob.mock.calls[0][1]).toMatchObject({ actorName: "Dee", roles: ["director"] });
  });
});

describe("one transaction", () => {
  it("rolls everything back when the ledger row fails", async () => {
    ledger.mockRejectedValueOnce(new Error("ledger unavailable"));

    await expect(completeNextStep(conn, as(ALANA), done())).rejects.toThrow("ledger unavailable");

    expect(world.events[world.events.length - 1]).toBe("rollback");
    expect(world.events).not.toContain("commit");
    expect(refusal).not.toHaveBeenCalled();
  });

  it("rolls everything back when the chase cannot be ended", async () => {
    resolveEscalation.mockRejectedValueOnce(new Error("stale"));
    await expect(completeNextStep(conn, as(ALANA), done())).rejects.toThrow("stale");
    expect(world.events).toEqual(["begin", "close step", "rollback"]);
    expect(ledger).not.toHaveBeenCalled();
  });

  it("rolls everything back when closing the job throws", async () => {
    closeJob.mockRejectedValueOnce(new Error("deadlock"));
    await expect(completeNextStep(conn, as(ALANA), done())).rejects.toThrow("deadlock");
    expect(world.events[world.events.length - 1]).toBe("rollback");
    expect(ledger).not.toHaveBeenCalled();
  });
});
