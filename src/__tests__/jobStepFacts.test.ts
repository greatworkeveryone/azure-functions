/// <reference types="jest" />
// The step and next action every job payload carries: read from the same records the transition guard reads, in
// four batched queries however many jobs a list has, and never disagreeing with the guard's own counts.
import type { HttpRequest, InvocationContext } from "@azure/functions";

export {};

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
}));
jest.mock("../approval-limits-db", () => ({
  getCachedApprovalLimits: jest.fn().mockResolvedValue([
    { MaxApprovalAmount: 5000, RoleName: "accounts" },
    { MaxApprovalAmount: 20000, RoleName: "accounts_manager" },
    { MaxApprovalAmount: null, RoleName: "director" },
  ]),
}));
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: jest.fn(() => "token"),
  requireRole: jest.fn().mockResolvedValue(null),
}));

const db = require("../db") as { executeQuery: jest.Mock };
const { buildStepFacts, withJobSteps } = require("../jobStepFacts") as typeof import("../jobStepFacts");
const { summariseInvoices } = require("../jobTransitionFacts") as typeof import("../jobTransitionFacts");
const { loadApprovalFacts } = jest.requireActual("../approvalAuthority-db") as typeof import("../approvalAuthority-db");

type Row = Record<string, unknown>;
const job = (extra: Row = {}): Row => ({ ApprovedQuoteID: null, AssignedTo: null, AssignedToUserID: null, AwaitingRole: "facilities", IsContract: false, IsInternal: false, JobID: 1, Status: "New", ...extra });

beforeEach(() => {
  delete process.env.DIRECTOR_APPROVAL_THRESHOLD;
  db.executeQuery.mockReset();
  db.executeQuery.mockResolvedValue([]);
});

describe("buildStepFacts agrees with the transition guard's invoice counts", () => {
  const rows: Row[] = [
    { Amount: 3000, Direction: "incoming", MyobCreatedAt: null, Status: "pending" },
    { Amount: 3000, Direction: "incoming", MyobCreatedAt: null, Status: "approved" },
    { Amount: 30000, Direction: "incoming", MyobCreatedAt: null, Status: "approved" },
    { Amount: 30000, Direction: "incoming", MyobCreatedAt: new Date(), Status: "director_approved" },
    { Amount: 900, Direction: "incoming", MyobCreatedAt: null, Status: "rejected" },
    { Amount: 900, Direction: "outgoing", MyobCreatedAt: null, Status: "approved" },
    { Amount: null, Direction: "incoming", MyobCreatedAt: null, Status: "awaiting_approval" },
  ];
  it.each([[[0]], [[1]], [[2]], [[3]], [[4]], [[5]], [[6]], [[0, 1, 2, 3, 4, 5, 6]], [[2, 3]], [[3, 4]]])("invoice rows %j", async (picks) => {
    const approval = await loadApprovalFacts({} as never, null);
    const picked = picks.map((index) => rows[index]);
    const guard = summariseInvoices(picked, approval);
    const facts = buildStepFacts(job(), { invoices: picked, purchaseOrders: [], quotes: [], requested: [] }, approval).invoices;
    expect(facts.incoming).toBe(guard.incomingInvoices);
    expect(facts.pending + facts.awaitingDirector).toBe(guard.incomingInvoicesAwaitingApproval);
    expect(facts.approvedNotInMyob).toBe(guard.approvedInvoicesNotInMyob);
  });
});

describe("buildStepFacts", () => {
  it("names the assignee and reads the job kind", async () => {
    const approval = await loadApprovalFacts({} as never, null);
    const facts = buildStepFacts(job({ AssignedTo: " Terry ", AssignedToUserID: 7, IsContract: true }), { invoices: [], purchaseOrders: [], quotes: [], requested: [] }, approval);
    expect(facts.assignee).toEqual({ name: "Terry", userId: 7 });
    expect(facts.kind).toBe("contract");
    expect(buildStepFacts(job({ IsContract: true, IsInternal: true }), { invoices: [], purchaseOrders: [], quotes: [], requested: [] }, approval).kind).toBe("internal");
  });

  it("counts quotes by stage, the approved one by the job's pointer, and sent requests", async () => {
    const approval = await loadApprovalFacts({} as never, null);
    const facts = buildStepFacts(
      job({ ApprovedQuoteID: 12 }),
      {
        invoices: [],
        purchaseOrders: [],
        quotes: [
          { Amount: 1000, CreatedBy: "Fran", CreatedByOid: "oid-f", QuoteID: 11, Status: "rejected" },
          { Amount: 2000, QuoteID: 12, Status: "approved" },
          { Amount: 90000, CreatedBy: "Fran", CreatedByOid: "oid-f", QuoteID: 13, Status: "pending" },
          { Amount: 3000, QuoteID: 14, Status: "awaiting_director" },
        ],
        requested: [{ RequestSent: true }, { RequestSent: false }, { RequestSent: true }],
      },
      approval,
    ).quotes;
    expect(facts).toMatchObject({ approved: true, awaitingDirector: 1, contractorsRequested: 3, declined: 1, pending: 1, pendingNeedsDirector: true, requestsSent: 2 });
    expect(facts.pendingCreator).toEqual({ name: "Fran", oid: "oid-f" });
  });

  it("counts purchase orders raised, complete, and not yet in MYOB", async () => {
    const approval = await loadApprovalFacts({} as never, null);
    const facts = buildStepFacts(job({ Status: "Work" }), { invoices: [], purchaseOrders: [{ CompletedAt: new Date(), MyobCreatedAt: null }, { CompletedAt: null, MyobCreatedAt: new Date() }], quotes: [], requested: [] }, approval);
    expect(facts.purchaseOrders).toEqual({ complete: 1, notInMyob: 1, raised: 2 });
  });
});

describe("withJobSteps", () => {
  it("reads four batches however many jobs there are, and attaches the step and next action to each", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (/FROM dbo\.Quotes/.test(sql)) return [{ Amount: 1000, JobID: 2, QuoteID: 5, Status: "approved" }];
      if (/FROM dbo\.PurchaseOrders/.test(sql)) return [{ CompletedAt: null, JobID: 2, MyobCreatedAt: null }];
      return [];
    });
    const rows = [job({ JobID: 1 }), job({ ApprovedQuoteID: 5, AssignedTo: "Terry", AssignedToUserID: 9, JobID: 2, Status: "Work" }), job({ JobID: 3, Status: "Done" })];
    const out = await withJobSteps({} as never, rows);
    // Four record reads and the approval threshold: the same number for one job as for three.
    const callsForThree = db.executeQuery.mock.calls.length;
    expect(callsForThree).toBe(5);
    db.executeQuery.mockClear();
    await withJobSteps({} as never, [rows[0]]);
    expect(db.executeQuery.mock.calls.length).toBe(callsForThree);
    expect(out.map((row) => (row.Step as { key: string }).key)).toEqual(["request_quotes", "work_under_way", "closed"]);
    expect(out[1].NextAction).toMatchObject({ jumpTarget: "po", verb: "Mark work complete", waitingOnUserId: 9, who: "Terry" });
  });

  it("leaves rows with no status (other shapes) alone and runs no query for them", async () => {
    const rows = [{ JobID: 4 }];
    expect(await withJobSteps({} as never, rows)).toBe(rows);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});

describe("getJobs and getJob carry the step", () => {
  type Handler = (request: HttpRequest, context: InvocationContext) => Promise<{ jsonBody?: { job?: Row; jobs?: Row[] } }>;
  require("../functions/jobs");
  const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
  const handler = (name: string): Handler => (app.http.mock.calls.find((c: unknown[]) => c[0] === name)![1] as { handler: Handler }).handler;
  const context = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

  it("on the job list, from one read of the records", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => (/FROM Jobs\s+WHERE/.test(sql) ? [job({ JobID: 1 }), job({ JobID: 2, Status: "Tenant" })] : []));
    const res = await handler("getJobs")({ headers: { get: () => null }, query: new URLSearchParams() } as unknown as HttpRequest, context);
    expect(res.jsonBody?.jobs?.map((row) => [row.JobID, (row.Step as { key: string }).key, (row.NextAction as { verb: string }).verb])).toEqual([
      [1, "request_quotes", "Request quotes"],
      [2, "on_hold", "Unblock job"],
    ]);
  });

  it("on a single job", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => (/FROM Jobs WHERE JobID/.test(sql) ? [job({ JobID: 5, Status: "Awaiting Approval", AwaitingRole: "accounts" })] : []));
    const res = await handler("getJob")({ headers: { get: () => null }, query: new URLSearchParams({ jobId: "5" }) } as unknown as HttpRequest, context);
    expect(res.jsonBody?.job).toMatchObject({ NextAction: { verb: "Add the invoice" }, Step: { key: "get_invoice", number: 5 } });
  });
});
