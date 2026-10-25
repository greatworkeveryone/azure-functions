/// <reference types="jest" />
// J3 review: the job loader's SQL is what every money rule decides on, so its
// shape is pinned: the job row locked to commit, and "has an approved quote"
// meaning a quote on this job, the one Jobs.ApprovedQuoteID names, in an
// approved (or completed) state. A refused money change rolls back, then
// ledgers in a transaction of its own.
import type { HttpRequest } from "@azure/functions";

jest.mock("../db", () => ({ executeQuery: jest.fn(), rollbackTransaction: jest.fn() }));
jest.mock("../ledger/actor", () => ({ resolveLedgerActor: jest.fn() }));
jest.mock("../ledger/refusals", () => ({ recordRefusal: jest.fn() }));

const db = require("../db") as { executeQuery: jest.Mock; rollbackTransaction: jest.Mock };
const actor = require("../ledger/actor") as { resolveLedgerActor: jest.Mock };
const refusals = require("../ledger/refusals") as { recordRefusal: jest.Mock };
const { loadJobForMoney, refuseMoneyChange } = require("../moneyJob-db") as typeof import("../moneyJob-db");

const connection = {} as never;
const sql = (): string => String(db.executeQuery.mock.calls[0][1]).replace(/\s+/g, " ");

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockResolvedValue([
    { BuildingID: 5, HasApprovedQuote: 1, IsArchived: 0, IsContract: 1, IsInternal: 0, JobID: 9, Kind: "maintenance", Status: "Work" },
  ]);
  db.rollbackTransaction.mockResolvedValue(undefined);
});

describe("loadJobForMoney", () => {
  it("locks the job row until commit", async () => {
    await loadJobForMoney(connection, 9);
    expect(sql()).toMatch(/FROM Jobs j WITH \(UPDLOCK, HOLDLOCK\) WHERE j\.JobID = @JobID/);
    expect(db.executeQuery.mock.calls[0][2]).toEqual([expect.objectContaining({ name: "JobID", value: 9 })]);
  });

  it("counts only the quote the job names, on this job, approved or completed", async () => {
    await loadJobForMoney(connection, 9);
    const exists = sql().match(/EXISTS \( SELECT 1 FROM Quotes q WHERE (.*?) \) THEN 1 ELSE 0 END AS HasApprovedQuote/)?.[1] ?? "";
    expect(exists).toContain("q.QuoteID = j.ApprovedQuoteID");
    expect(exists).toContain("q.JobID = j.JobID");
    expect(exists).toContain("q.Status IN ('approved', 'completed')");
    expect(exists.split(" AND ")).toHaveLength(3);
  });

  it("reads the row's flags as booleans", async () => {
    expect(await loadJobForMoney(connection, 9)).toEqual({
      buildingId: 5,
      hasApprovedQuote: true,
      isArchived: false,
      isContract: true,
      isInternal: false,
      jobId: 9,
      kind: "maintenance",
      status: "Work",
    });
  });

  it("reads the job's kind, and a job with none stored reads as facilities", async () => {
    await loadJobForMoney(connection, 9);
    expect(sql()).toMatch(/j\.Kind/);

    db.executeQuery.mockResolvedValue([{ BuildingID: 5, JobID: 9, Kind: null, Status: "Work" }]);
    expect(await loadJobForMoney(connection, 9)).toMatchObject({ kind: "facilities" });
  });

  it("is null for a job that isn't there", async () => {
    db.executeQuery.mockResolvedValue([]);
    expect(await loadJobForMoney(connection, 9)).toBeNull();
  });
});

describe("refuseMoneyChange", () => {
  const request = {} as HttpRequest;
  const refusal = { code: "job_done", message: "This job is done.", status: 409 as const };

  it("rolls the decision back first, then ledgers the refused attempt, then answers with it", async () => {
    actor.resolveLedgerActor.mockResolvedValue({ kind: "user", name: "Fran", role: "facilities_manager", userId: 3 });

    const res = await refuseMoneyChange(connection, request, { attempted: "quote.edit", jobId: 9, refusal, subject: { id: 7, type: "quote" } });

    expect(res).toEqual({ jsonBody: { code: "job_done", error: "This job is done." }, status: 409 });
    expect(db.rollbackTransaction.mock.invocationCallOrder[0]).toBeLessThan(refusals.recordRefusal.mock.invocationCallOrder[0]);
    expect(refusals.recordRefusal).toHaveBeenCalledWith(
      connection,
      expect.objectContaining({ name: "Fran" }),
      { id: 7, type: "quote" },
      { attempted: "quote.edit", code: "job_done", message: "This job is done.", state: undefined },
      9,
    );
  });

  it("still answers when nobody can be named for the ledger", async () => {
    actor.resolveLedgerActor.mockResolvedValue(null);
    const res = await refuseMoneyChange(connection, request, { attempted: "quote.edit", jobId: 9, refusal, subject: { id: 7, type: "quote" } });
    expect(res.status).toBe(409);
    expect(refusals.recordRefusal).not.toHaveBeenCalled();
  });
});
