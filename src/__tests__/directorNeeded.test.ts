/// <reference types="jest" />
// J4: the director-needed count uses the final-state rule. A stage-1
// ('approved') invoice waits on a director only when its amount needs one; a
// quote in 'awaiting_director' always does. The Jobs list, a job's own read and
// the director's Planner task all count this way.
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
const { directorNeededCount, withDirectorNeeded, DIRECTOR_NEEDED_COLUMNS } = require("../directorNeeded") as typeof import("../directorNeeded");
const { loadApprovalFacts } = jest.requireActual("../approvalAuthority-db") as typeof import("../approvalAuthority-db");

const amounts = (...values: (number | null)[]): string => JSON.stringify(values.map((Amount) => (Amount === null ? {} : { Amount })));

beforeEach(() => {
  delete process.env.DIRECTOR_APPROVAL_THRESHOLD;
  db.executeQuery.mockReset();
  db.executeQuery.mockResolvedValue([]);
});

describe("directorNeededCount", () => {
  it.each([
    ["a stage-1 invoice under the gate: final, nobody waits", { QuotesAwaitingDirector: 0, StageOneInvoiceAmounts: amounts(4000) }, 0],
    ["a stage-1 invoice over the gate: the director", { QuotesAwaitingDirector: 0, StageOneInvoiceAmounts: amounts(30000) }, 1],
    ["a stage-1 invoice with no amount: the director", { QuotesAwaitingDirector: 0, StageOneInvoiceAmounts: amounts(null) }, 1],
    ["quotes parked with the director, and a mix of invoices", { QuotesAwaitingDirector: 2, StageOneInvoiceAmounts: amounts(4000, 25000) }, 3],
    ["nothing at stage 1", { QuotesAwaitingDirector: 0, StageOneInvoiceAmounts: null }, 0],
  ])("%s", async (_label, row, expected) => {
    const facts = await loadApprovalFacts({} as never, null);
    expect(directorNeededCount(row, facts)).toBe(expected);
  });

  it("follows DIRECTOR_APPROVAL_THRESHOLD when it is set", async () => {
    process.env.DIRECTOR_APPROVAL_THRESHOLD = "50000";
    const facts = await loadApprovalFacts({} as never, null);
    expect(directorNeededCount({ StageOneInvoiceAmounts: amounts(30000) }, facts)).toBe(0);
    expect(directorNeededCount({ StageOneInvoiceAmounts: amounts(60000) }, facts)).toBe(1);
  });
});

describe("withDirectorNeeded", () => {
  it("sets the count and drops the working columns", async () => {
    const rows = await withDirectorNeeded({} as never, [{ JobID: 1, QuotesAwaitingDirector: 1, StageOneInvoiceAmounts: amounts(4000) }]);
    expect(rows).toEqual([{ DirectorNeededCount: 1, JobID: 1 }]);
  });

  it("leaves rows read without the working columns alone", async () => {
    const rows = [{ DirectorNeededCount: 2, JobID: 1 }];
    expect(await withDirectorNeeded({} as never, rows)).toBe(rows);
  });
});

describe("getJobs", () => {
  type Handler = (request: HttpRequest, context: InvocationContext) => Promise<{ jsonBody?: { jobs: Record<string, unknown>[] } }>;
  require("../functions/jobs");
  const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
  const getJobs = (app.http.mock.calls.find((c: unknown[]) => c[0] === "getJobs")![1] as { handler: Handler }).handler;

  it("reads the working columns and answers with the final-state count", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) =>
      /FROM Jobs\s+WHERE/.test(sql)
        ? [
            { JobID: 1, QuotesAwaitingDirector: 0, StageOneInvoiceAmounts: amounts(4000) },
            { JobID: 2, QuotesAwaitingDirector: 0, StageOneInvoiceAmounts: amounts(30000) },
          ]
        : [],
    );
    const request = { headers: { get: () => null }, query: new URLSearchParams() } as unknown as HttpRequest;

    const res = await getJobs(request, { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext);

    expect(String(db.executeQuery.mock.calls[0][1])).toContain(DIRECTOR_NEEDED_COLUMNS);
    expect(res.jsonBody?.jobs.map((job) => [job.JobID, job.DirectorNeededCount])).toEqual([
      [1, 0],
      [2, 1],
    ]);
    expect(res.jsonBody?.jobs[0]).not.toHaveProperty("StageOneInvoiceAmounts");
  });
});
