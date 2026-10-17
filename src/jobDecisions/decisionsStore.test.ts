/// <reference types="jest" />
// The parts of the decisions store that are not just SQL text: what is read back from
// a row, and what each statement sends. The SQL itself is checked against the
// migration (migration-138-job-decisions.test.ts) and against a real SQL Server
// before it merged.
import { TYPES, type Connection } from "tedious";
import {
  activeUserIdByOid,
  closeNextStep,
  decisionForRequest,
  dueDeferrals,
  getDecisionRow,
  hasLaterRequest,
  hasScheduledReask,
  insertDecision,
  insertJobEvent,
  jobParties,
  latestDecisionForJob,
  markRequestAnswered,
  openNextSteps,
  reassignJob,
  stampReask,
  toDecisionRow,
  type NewDecision,
} from "./decisionsStore";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));

const db = require("../db") as { executeQuery: jest.Mock };
const conn = {} as Connection;
const VERSION = Buffer.from([0, 0, 0, 0, 0, 0, 0, 3]);
const VERSION_TEXT = VERSION.toString("base64");

const raw = (over: Record<string, unknown> = {}) => ({
  DecisionId: 4,
  DeferUntil: null,
  JobId: 12,
  NextStep: "Pay the invoice",
  NextStepClosedAt: null,
  NextStepClosedById: null,
  NextStepClosedByName: null,
  NextStepClosedKind: null,
  NextStepClosedNote: null,
  NextStepDueAt: new Date("2026-10-19T07:30:00Z"),
  NextStepOwnerRole: null,
  NextStepOwnerUserId: 9,
  Outcome: "approve",
  Rationale: "Ordered twice",
  ReaskRequestId: null,
  RequestId: 7,
  RespondedAt: new Date("2026-10-12T00:30:00Z"),
  RespondedById: 5,
  RespondedByName: "Dee",
  RowVersion: VERSION,
  ...over,
});

const placeholders = (sql: string): string[] => [...new Set([...sql.matchAll(/@(\w+)/g)].map((m) => m[1]))].sort();
const names = (params: { name: string }[]): string[] => params.map((p) => p.name).sort();

beforeEach(() => {
  db.executeQuery.mockReset();
  db.executeQuery.mockResolvedValue([]);
});

describe("toDecisionRow", () => {
  it("reads an open step", () => {
    expect(toDecisionRow(raw())).toEqual({
      decisionId: 4,
      deferUntil: null,
      jobId: 12,
      nextStep: "Pay the invoice",
      nextStepClosed: null,
      nextStepDueAt: new Date("2026-10-19T07:30:00Z"),
      nextStepOwnerRole: null,
      nextStepOwnerUserId: 9,
      outcome: "approve",
      rationale: "Ordered twice",
      reaskRequestId: null,
      requestId: 7,
      respondedAt: new Date("2026-10-12T00:30:00Z"),
      respondedById: 5,
      respondedByName: "Dee",
      rowVersion: VERSION_TEXT,
    });
  });

  it("reads a step that was done, with who, when and the note", () => {
    const row = toDecisionRow(
      raw({ NextStepClosedAt: new Date("2026-10-14T01:00:00Z"), NextStepClosedById: 9, NextStepClosedByName: "Alana", NextStepClosedKind: "done", NextStepClosedNote: "Paid" }),
    );
    expect(row.nextStepClosed).toEqual({ at: new Date("2026-10-14T01:00:00Z"), byId: 9, byName: "Alana", kind: "done", note: "Paid" });
  });

  it("reads a step a later decision took over, and treats anything else as done", () => {
    const closed = { NextStepClosedAt: new Date("2026-10-14T01:00:00Z"), NextStepClosedByName: "Dee" };
    expect(toDecisionRow(raw({ ...closed, NextStepClosedKind: "replaced" })).nextStepClosed?.kind).toBe("replaced");
    expect(toDecisionRow(raw({ ...closed, NextStepClosedKind: "done" })).nextStepClosed?.kind).toBe("done");
  });

  it("reads a deferral's day as YYYY-MM-DD whether the driver gives a Date at midnight UTC or text", () => {
    expect(toDecisionRow(raw({ DeferUntil: new Date("2026-10-23T00:00:00Z"), Outcome: "defer" })).deferUntil).toBe("2026-10-23");
    expect(toDecisionRow(raw({ DeferUntil: "2026-10-23", Outcome: "defer" })).deferUntil).toBe("2026-10-23");
    expect(toDecisionRow(raw({ DeferUntil: null })).deferUntil).toBeNull();
  });

  it("reads a step for a role, and a decision with no step", () => {
    expect(toDecisionRow(raw({ NextStepOwnerRole: "accounts", NextStepOwnerUserId: null })).nextStepOwnerRole).toBe("accounts");
    const none = toDecisionRow(raw({ NextStep: null, NextStepDueAt: null, NextStepOwnerUserId: null, Outcome: "defer" }));
    expect(none).toMatchObject({ nextStep: null, nextStepDueAt: null, nextStepOwnerUserId: null });
  });
});

describe("the reads", () => {
  it("get one decision, locking it only when asked to", async () => {
    db.executeQuery.mockResolvedValueOnce([raw()]);
    expect((await getDecisionRow(conn, 4))?.decisionId).toBe(4);
    expect(db.executeQuery.mock.calls[0][1]).not.toMatch(/UPDLOCK/);

    db.executeQuery.mockResolvedValueOnce([raw()]);
    await getDecisionRow(conn, 4, { forUpdate: true });
    expect(db.executeQuery.mock.calls[1][1]).toMatch(/WITH \(UPDLOCK, ROWLOCK\)/);
    expect(db.executeQuery.mock.calls[1][2]).toEqual([{ name: "DecisionId", type: TYPES.Int, value: 4 }]);
  });

  it("find nothing as null", async () => {
    expect(await getDecisionRow(conn, 4)).toBeNull();
    expect(await decisionForRequest(conn, 7)).toBeNull();
    expect(await latestDecisionForJob(conn, 12)).toBeNull();
    expect(await openNextSteps(conn, 12)).toEqual([]);
  });

  it("find nothing, quietly, in a database that has not had migration 138 applied: a build ahead of its migration still shows the request", async () => {
    const missing = Object.assign(new Error("Invalid object name 'dbo.JobDecisions'."), { number: 208 });
    db.executeQuery.mockRejectedValueOnce(missing).mockRejectedValueOnce(missing);
    expect(await decisionForRequest(conn, 7)).toBeNull();
    expect(await latestDecisionForJob(conn, 12)).toBeNull();
  });

  it("do not hide any other failure of the read", async () => {
    db.executeQuery.mockRejectedValueOnce(Object.assign(new Error("deadlock"), { number: 1205 }));
    await expect(decisionForRequest(conn, 7)).rejects.toThrow("deadlock");
    db.executeQuery.mockRejectedValueOnce(new Error("socket closed"));
    await expect(latestDecisionForJob(conn, 12)).rejects.toThrow("socket closed");
  });

  it("find the decision that answered a request, the newest on a job and the steps still open, newest first", async () => {
    db.executeQuery.mockResolvedValueOnce([raw()]);
    expect((await decisionForRequest(conn, 7))?.requestId).toBe(7);
    expect(db.executeQuery.mock.calls[0][1]).toMatch(/WHERE RequestId = @RequestId/);

    db.executeQuery.mockResolvedValueOnce([raw()]);
    await latestDecisionForJob(conn, 12);
    expect(db.executeQuery.mock.calls[1][1]).toMatch(/TOP 1 .* WHERE JobId = @JobId ORDER BY DecisionId DESC/s);

    db.executeQuery.mockResolvedValueOnce([raw({ DecisionId: 5 }), raw({ DecisionId: 4 })]);
    expect((await openNextSteps(conn, 12)).map((row) => row.decisionId)).toEqual([5, 4]);
    expect(db.executeQuery.mock.calls[2][1]).toMatch(/NextStep IS NOT NULL AND NextStepClosedAt IS NULL\s+ORDER BY DecisionId DESC/);
  });

  it("answer 'is a deferral still waiting' and 'is there a later request' as booleans", async () => {
    db.executeQuery.mockResolvedValueOnce([{ Scheduled: 1 }]);
    expect(await hasScheduledReask(conn, 12)).toBe(true);
    expect(db.executeQuery.mock.calls[0][1]).toMatch(/Outcome = N'defer' AND d\.ReaskRequestId IS NULL/);
    expect(db.executeQuery.mock.calls[0][1]).toMatch(/r\.RequestId > d\.RequestId/);
    db.executeQuery.mockResolvedValueOnce([{ Scheduled: 0 }]);
    expect(await hasScheduledReask(conn, 12)).toBe(false);

    db.executeQuery.mockResolvedValueOnce([{ HasLater: 1 }]);
    expect(await hasLaterRequest(conn, 12, 7)).toBe(true);
    expect(db.executeQuery.mock.calls[2][2]).toEqual([
      { name: "JobId", type: TYPES.Int, value: 12 },
      { name: "RequestId", type: TYPES.Int, value: 7 },
    ]);
    db.executeQuery.mockResolvedValueOnce([]);
    expect(await hasLaterRequest(conn, 12, 7)).toBe(false);
  });

  it("read who raised the job and who has it, and find a user by their Entra id", async () => {
    db.executeQuery.mockResolvedValueOnce([{ AssignedTo: "Fay", AssignedToUserID: 8, CreatedBy: "Alana", CreatedById: "oid-9" }]);
    expect(await jobParties(conn, 12)).toEqual({ assignedTo: "Fay", assignedToUserId: 8, createdBy: "Alana", createdById: "oid-9" });
    db.executeQuery.mockResolvedValueOnce([]);
    expect(await jobParties(conn, 99)).toBeNull();

    db.executeQuery.mockResolvedValueOnce([{ UserID: 9 }]);
    expect(await activeUserIdByOid(conn, "oid-9")).toBe(9);
    expect(db.executeQuery.mock.calls[2][1]).toMatch(/EntraOid = @Oid AND IsActive = 1/);
    db.executeQuery.mockResolvedValueOnce([]);
    expect(await activeUserIdByOid(conn, "oid-x")).toBeNull();
  });
});

describe("dueDeferrals", () => {
  it("asks for the deferrals whose day has come on a live job with no request since, oldest first", async () => {
    db.executeQuery.mockResolvedValueOnce([
      { DecisionId: 4, DeferUntil: new Date("2026-10-23T00:00:00Z"), JobId: 12, RequestId: 7 },
      { DecisionId: 6, DeferUntil: new Date("2026-10-26T00:00:00Z"), JobId: 14, RequestId: 9 },
    ]);

    const due = await dueDeferrals(conn, "2026-10-26", 100);

    expect(due).toEqual([
      { decisionId: 4, deferUntil: "2026-10-23", jobId: 12, requestId: 7 },
      { decisionId: 6, deferUntil: "2026-10-26", jobId: 14, requestId: 9 },
    ]);
    const [, sql, params] = db.executeQuery.mock.calls[0];
    expect(sql).toMatch(/Outcome = N'defer' AND d\.ReaskRequestId IS NULL AND d\.DeferUntil <= @Today/);
    expect(sql).toMatch(/j\.IsArchived = 0 AND j\.Status <> N'Done'/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM dbo\.JobDecisionRequests r WHERE r\.JobId = d\.JobId AND r\.RequestId > d\.RequestId\)/);
    expect(sql).toMatch(/ORDER BY d\.DeferUntil, d\.DecisionId/);
    expect(params).toEqual([
      { name: "Limit", type: TYPES.Int, value: 100 },
      { name: "Today", type: TYPES.Date, value: "2026-10-26" },
    ]);
  });

  it("finds none, quietly, in a database that has not had migration 138 applied (a build ahead of its migration)", async () => {
    db.executeQuery.mockRejectedValueOnce(Object.assign(new Error("Invalid object name 'dbo.JobDecisions'."), { number: 208 }));
    expect(await dueDeferrals(conn, "2026-10-26", 100)).toEqual([]);
  });

  it("does not hide any other failure", async () => {
    db.executeQuery.mockRejectedValueOnce(Object.assign(new Error("deadlock"), { number: 1205 }));
    await expect(dueDeferrals(conn, "2026-10-26", 100)).rejects.toThrow("deadlock");
  });
});

describe("the writes", () => {
  const NEW: NewDecision = {
    deferUntil: null,
    jobId: 12,
    nextStep: "Pay the invoice",
    nextStepDueAt: new Date("2026-10-19T07:30:00Z"),
    nextStepOwnerRole: null,
    nextStepOwnerUserId: 9,
    outcome: "approve",
    rationale: "Ordered twice",
    requestId: 7,
    respondedAt: new Date("2026-10-12T00:30:00Z"),
    respondedById: 5,
    respondedByName: "Dee",
  };

  it("insertDecision sends a parameter for every placeholder, in the column the table has, and returns the id", async () => {
    db.executeQuery.mockResolvedValueOnce([{ DecisionId: 4 }]);

    expect(await insertDecision(conn, NEW)).toBe(4);

    const [, sql, params] = db.executeQuery.mock.calls[0];
    expect(names(params)).toEqual(placeholders(sql));
    expect(sql).toMatch(/INSERT INTO dbo\.JobDecisions\s*\(RequestId, JobId, Outcome, Rationale, NextStep, NextStepOwnerUserId, NextStepOwnerRole, NextStepDueAt, DeferUntil,\s*RespondedById, RespondedByName, RespondedAt\)/);
    expect(params).toContainEqual({ name: "DeferUntil", type: TYPES.Date, value: null });
    expect(params).toContainEqual({ name: "NextStepOwnerUserId", type: TYPES.Int, value: 9 });
    expect(params).toContainEqual({ name: "NextStepDueAt", type: TYPES.DateTime2, value: NEW.nextStepDueAt, options: { scale: 3 } });
  });

  it("insertDecision sends a deferral's day as a date, and a step for a role with no person", async () => {
    db.executeQuery.mockResolvedValueOnce([{ DecisionId: 5 }]);
    await insertDecision(conn, { ...NEW, deferUntil: "2026-10-23", nextStepOwnerRole: "accounts", nextStepOwnerUserId: null, outcome: "defer" });
    const params = db.executeQuery.mock.calls[0][2];
    expect(params).toContainEqual({ name: "DeferUntil", type: TYPES.Date, value: "2026-10-23" });
    expect(params).toContainEqual({ name: "NextStepOwnerRole", type: TYPES.NVarChar, value: "accounts" });
    expect(params).toContainEqual({ name: "NextStepOwnerUserId", type: TYPES.Int, value: null });
  });

  it("markRequestAnswered answers a request only while it is pending and still the version read", async () => {
    db.executeQuery.mockResolvedValueOnce([{ RequestId: 7 }]);
    expect(await markRequestAnswered(conn, 7, VERSION_TEXT)).toBe(true);
    const [, sql, params] = db.executeQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE dbo\.JobDecisionRequests SET State = N'answered'/);
    expect(sql).toMatch(/WHERE RequestId = @RequestId AND State = N'pending' AND RowVersion = @RowVersion/);
    expect(params).toContainEqual({ name: "RowVersion", type: TYPES.Binary, value: VERSION });
    expect(names(params)).toEqual(placeholders(sql));

    db.executeQuery.mockResolvedValueOnce([]);
    expect(await markRequestAnswered(conn, 7, VERSION_TEXT)).toBe(false);
  });

  it("markRequestAnswered refuses a version that is not 8 bytes before it sends anything", async () => {
    await expect(markRequestAnswered(conn, 7, "AAAA")).rejects.toThrow(/not a valid version/);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  describe("closeNextStep", () => {
    const closing = { at: new Date("2026-10-14T01:00:00Z"), byId: 9, byName: "Alana", kind: "done" as const, note: "Paid" };

    it("closes an open step once, by anyone who holds the lock, when no version is given", async () => {
      db.executeQuery.mockResolvedValueOnce([{ DecisionId: 4 }]);
      expect(await closeNextStep(conn, 4, closing)).toBe(true);
      const [, sql, params] = db.executeQuery.mock.calls[0];
      expect(sql).toMatch(/WHERE DecisionId = @DecisionId AND NextStep IS NOT NULL AND NextStepClosedAt IS NULL$/);
      expect(sql).not.toMatch(/RowVersion/);
      expect(names(params)).toEqual(placeholders(sql));
      expect(params).toContainEqual({ name: "Kind", type: TYPES.NVarChar, value: "done" });
    });

    it("closes it only at the version the screen read when one is given", async () => {
      db.executeQuery.mockResolvedValueOnce([]);
      expect(await closeNextStep(conn, 4, { ...closing, expectedRowVersion: VERSION_TEXT })).toBe(false);
      const [, sql, params] = db.executeQuery.mock.calls[0];
      expect(sql).toMatch(/AND RowVersion = @RowVersion$/);
      expect(params).toContainEqual({ name: "RowVersion", type: TYPES.Binary, value: VERSION });
      expect(names(params)).toEqual(placeholders(sql));
    });

    it("can close a step as replaced", async () => {
      db.executeQuery.mockResolvedValueOnce([{ DecisionId: 4 }]);
      await closeNextStep(conn, 4, { ...closing, kind: "replaced", note: null });
      expect(db.executeQuery.mock.calls[0][2]).toContainEqual({ name: "Kind", type: TYPES.NVarChar, value: "replaced" });
    });
  });

  it("stampReask records the request a deferral came back as, once", async () => {
    db.executeQuery.mockResolvedValueOnce([{ DecisionId: 4 }]);
    expect(await stampReask(conn, 4, 9)).toBe(true);
    const [, sql, params] = db.executeQuery.mock.calls[0];
    expect(sql).toMatch(/SET ReaskRequestId = @RequestId[\s\S]*WHERE DecisionId = @DecisionId AND Outcome = N'defer' AND ReaskRequestId IS NULL/);
    expect(names(params)).toEqual(placeholders(sql));

    db.executeQuery.mockResolvedValueOnce([]);
    expect(await stampReask(conn, 4, 10)).toBe(false);
  });

  it("reassignJob hands the job to a person, or to a role by its label with no person", async () => {
    await reassignJob(conn, 12, { name: "Alana", userId: 9 });
    await reassignJob(conn, 12, { name: "Accounts", userId: null });
    const [first, second] = db.executeQuery.mock.calls;
    expect(first[1]).toMatch(/UPDATE dbo\.Jobs SET AssignedTo = @AssignedTo, AssignedToUserID = @AssignedToUserID, LastModifiedDate = SYSUTCDATETIME\(\) WHERE JobID = @JobID/);
    expect(first[2]).toEqual(expect.arrayContaining([{ name: "AssignedTo", type: TYPES.NVarChar, value: "Alana" }, { name: "AssignedToUserID", type: TYPES.Int, value: 9 }]));
    expect(second[2]).toEqual(expect.arrayContaining([{ name: "AssignedToUserID", type: TYPES.Int, value: null }]));
    expect(names(first[2])).toEqual(placeholders(first[1]));
  });

  it("insertJobEvent writes one row of the activity feed", async () => {
    await insertJobEvent(conn, { createdBy: "Dee", eventType: "decision", jobId: 12, text: "Approved by Dee: x" });
    const [, sql, params] = db.executeQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO dbo\.JobEvents \(JobID, CreatedBy, \[Text\], EventType, NewAssignee, NewStatus, NewAwaitingRole\)/);
    expect(names(params)).toEqual(placeholders(sql));
    expect(params).toContainEqual({ name: "NewStatus", type: TYPES.NVarChar, value: null });
  });
});

describe("no statement here selects every column", () => {
  it("lists the columns it reads", async () => {
    db.executeQuery.mockResolvedValue([raw()]);
    await getDecisionRow(conn, 4);
    await decisionForRequest(conn, 7);
    await latestDecisionForJob(conn, 12);
    await openNextSteps(conn, 12);
    for (const [, sql] of db.executeQuery.mock.calls) expect(sql).not.toMatch(/SELECT\s+(TOP\s+\d+\s+)?\*/i);
  });
});
