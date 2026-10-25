/// <reference types="jest" />
// D9: only an admin flips a record's test flag after it is created; the
// frontend asks them to confirm. The change and its ledger row commit together.
import type { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: jest.fn().mockReturnValue("tok"),
  requireRole: jest.fn().mockResolvedValue(null),
}));
jest.mock("../ledger", () => ({ record: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../ledger/actor", () => ({ resolveLedgerActor: jest.fn().mockResolvedValue({ kind: "user", name: "Ada Admin", role: "admin", userId: 1 }) }));
jest.mock("../tenant-register-cache", () => ({ invalidateTenantAndBuilding: jest.fn() }));

import { AppRole } from "../auth";
import { JOB_PROPOSALS_SQL, setTestFlag, SET_TEST_FLAG_SQL } from "./setTestFlag";

const auth = require("../auth") as { requireRole: jest.Mock };
const db = require("../db") as Record<"beginTransaction" | "commitTransaction" | "executeQuery" | "rollbackTransaction", jest.Mock>;
const ledger = require("../ledger") as { record: jest.Mock };
const cache = require("../tenant-register-cache") as { invalidateTenantAndBuilding: jest.Mock };

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const post = (body: unknown) => ({ headers: { get: () => null }, json: async () => body }) as unknown as HttpRequest;

const NO_DECISIONS = { ApprovedQuoteID: null, InvoiceDecisions: 0, Payments: 0, PoDecisions: 0, QuoteDecisions: 0 };
let facts: Record<string, unknown>;
let proposals: number;

beforeEach(() => {
  jest.clearAllMocks();
  auth.requireRole.mockResolvedValue(null);
  facts = { ...NO_DECISIONS };
  proposals = 0;
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    if (/WITH \(UPDLOCK, HOLDLOCK\)/.test(sql)) return [{ BuildingId: 3, IsTest: false, TenantId: null, ...facts }];
    if (/MyobProposals/.test(sql)) return [{ Proposals: proposals }];
    return [];
  });
});

describe("setTestFlag", () => {
  it("is for admins only", async () => {
    await setTestFlag(post({ Id: 9, IsTest: true, Kind: "job", Reason: "Demo job" }), ctx);
    expect(auth.requireRole.mock.calls[0][1]).toEqual([AppRole.ADMIN]);
    auth.requireRole.mockResolvedValue({ jsonBody: { error: "Forbidden" }, status: 403 });
    expect((await setTestFlag(post({ Id: 9, IsTest: true, Kind: "job", Reason: "Demo job" }), ctx)).status).toBe(403);
  });

  it.each([
    { Id: 9, Kind: "job", Reason: "x" },
    { Id: 9, IsTest: "yes", Kind: "job", Reason: "x" },
    { IsTest: true, Kind: "job", Reason: "x" },
    { Id: 9, IsTest: true, Kind: "quote", Reason: "x" },
    { Id: 9, IsTest: true, Kind: "job" },
    { Id: 9, IsTest: true, Kind: "job", Reason: "   " },
  ])(
    "refuses %p (400) before touching the database",
    async (body) => {
      expect((await setTestFlag(post(body), ctx)).status).toBe(400);
      expect(db.executeQuery).not.toHaveBeenCalled();
    },
  );

  it.each(["job", "tenancy", "inspection", "key", "vacancy"] as const)("flips a %s, locked, and ledgers it in the same transaction", async (kind) => {
    const res = await setTestFlag(post({ Id: 9, IsTest: true, Kind: kind, Reason: "Made by mistake as real" }), ctx);
    expect(res.status).toBe(200);
    const update = db.executeQuery.mock.calls.find((c: unknown[]) => c[1] === SET_TEST_FLAG_SQL[kind].update);
    expect(update?.[2]).toEqual(expect.arrayContaining([expect.objectContaining({ name: "IsTest", value: true }), expect.objectContaining({ name: "Id", value: 9 })]));
    expect(SET_TEST_FLAG_SQL[kind].read).toMatch(/WITH \(UPDLOCK, HOLDLOCK\)/);
    expect(ledger.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "test_data.flag",
        after: { isTest: true },
        before: { isTest: false },
        reason: "Made by mistake as real",
        subject: { id: 9, type: kind },
      }),
    );
    expect(ledger.record.mock.invocationCallOrder[0]).toBeLessThan(db.commitTransaction.mock.invocationCallOrder[0]);
  });

  it("answers 404 for a missing record and 409 when it is already that way, writing nothing", async () => {
    db.executeQuery.mockResolvedValue([]);
    expect((await setTestFlag(post({ Id: 9, IsTest: true, Kind: "job", Reason: "Demo job" }), ctx)).status).toBe(404);
    db.executeQuery.mockResolvedValue([{ BuildingId: 3, IsTest: true }]);
    expect((await setTestFlag(post({ Id: 9, IsTest: true, Kind: "job", Reason: "Demo job" }), ctx)).status).toBe(409);
    expect(ledger.record).not.toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("refreshes the register when a tenancy changes", async () => {
    await setTestFlag(post({ Id: 9, IsTest: true, Kind: "tenancy", Reason: "Training tenancy" }), ctx);
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(9, 3);
  });
});

describe("setTestFlag and money decisions (D9 review: decision 4 must not be bypassed)", () => {
  const DECIDED: [string, Record<string, unknown>, number, RegExp][] = [
    ["an approved quote on the job", { ApprovedQuoteID: 31 }, 0, /approved quote/],
    ["a quote approved, completed, sent to a director or emailed to one", { QuoteDecisions: 1 }, 0, /quote decision/],
    ["an invoice approved, director-approved, paid, MYOB-marked or emailed to a director", { InvoiceDecisions: 2 }, 0, /invoice decision/],
    ["a PO sent, completed or MYOB-marked", { PoDecisions: 1 }, 0, /purchase order/],
    ["a payment", { Payments: 1 }, 0, /payment/],
    ["a MYOB proposal", {}, 1, /MYOB proposal/],
  ];

  it.each(DECIDED)("refuses real → test once the job has %s (409), writing and ledgering nothing", async (_label, over, props, reason) => {
    facts = { ...NO_DECISIONS, ...over };
    proposals = props;
    const res = await setTestFlag(post({ Id: 9, IsTest: true, Kind: "job", Reason: "Demo" }), ctx);
    expect(res.status).toBe(409);
    expect(res.jsonBody?.error).toMatch(/can't become test data/);
    expect(res.jsonBody?.error).toMatch(reason);
    expect(db.executeQuery.mock.calls.some((c: unknown[]) => /UPDATE dbo\.Jobs SET IsTest/.test(String(c[1])))).toBe(false);
    expect(ledger.record).not.toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it.each(DECIDED)("refuses test → real once it has %s: those decisions were taken while it was test data", async (_label, over, props) => {
    facts = { ...NO_DECISIONS, ...over };
    proposals = props;
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (/WITH \(UPDLOCK, HOLDLOCK\)/.test(sql)) return [{ BuildingId: 3, IsTest: true, ...facts }];
      if (/MyobProposals/.test(sql)) return [{ Proposals: proposals }];
      return [];
    });
    const res = await setTestFlag(post({ Id: 9, IsTest: false, Kind: "job", Reason: "Real after all" }), ctx);
    expect(res.status).toBe(409);
    expect(res.jsonBody?.error).toMatch(/can't become real data/);
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it("reads every money decision under the job's lock", () => {
    const read = SET_TEST_FLAG_SQL.job.read;
    expect(read).toMatch(/FROM dbo\.Jobs j WITH \(UPDLOCK, HOLDLOCK\)/);
    expect(read).toMatch(/j\.ApprovedQuoteID/);
    expect(read).toMatch(/FROM dbo\.Quotes q WHERE q\.JobID = j\.JobID AND \(q\.Status IN \(N'approved', N'awaiting_director', N'completed'\) OR q\.DirectorEmailSentAt IS NOT NULL\)/);
    expect(read).toMatch(
      /FROM dbo\.JobInvoices i WHERE i\.JobID = j\.JobID AND \(i\.Status IN \(N'approved', N'director_approved', N'awaiting_approval'\) OR i\.MyobCreatedAt IS NOT NULL OR i\.DirectorEmailSentAt IS NOT NULL\)/,
    );
    expect(read).toMatch(/FROM dbo\.PurchaseOrders po WHERE po\.JobID = j\.JobID AND \(po\.SentAt IS NOT NULL OR po\.MyobCreatedAt IS NOT NULL OR po\.CompletedAt IS NOT NULL\)/);
    expect(read).toMatch(/FROM dbo\.Payments p WHERE p\.JobID = j\.JobID\)/);
    expect(JOB_PROPOSALS_SQL).toMatch(/IF OBJECT_ID\(N'dbo\.MyobProposals', N'U'\) IS NOT NULL/);
    expect(JOB_PROPOSALS_SQL).toMatch(/FROM dbo\.MyobProposals WHERE JobId = @Id/);
  });

  it("lets a job with no money decisions go either way, with its reason ledgered", async () => {
    expect((await setTestFlag(post({ Id: 9, IsTest: true, Kind: "job", Reason: "Demo job" }), ctx)).status).toBe(200);
    expect(ledger.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reason: "Demo job" }));
  });
});
