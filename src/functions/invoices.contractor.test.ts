/// <reference types="jest" />
// Who an invoice is from (migration 112): the contractor's id is stored when the
// request gives it, and never worked out from a name when an invoice is written.
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});

jest.mock("../db", () => {
  const actual = jest.requireActual("../db");
  return {
    beginTransaction: jest.fn().mockResolvedValue(undefined),
    buildUpdateSet: actual.buildUpdateSet,
    closeConnection: jest.fn(),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    createRequestConnection: jest.fn().mockResolvedValue({}),
    executeQuery: jest.fn(),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
  };
});

jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    requireRole: jest.fn().mockResolvedValue(null),
    unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
    verifiedIdentityFromRequest: jest.fn().mockResolvedValue({
      email: "ann@randazzo.properties",
      name: "Ann Accounts",
      oid: "ann-oid",
    }),
  };
});

jest.mock("../approval-limits-db", () => ({ getCachedApprovalLimits: jest.fn().mockResolvedValue([]) }));
jest.mock("../mybuildings-client", () => ({ fetchInvoices: jest.fn() }));
jest.mock("../planner", () => ({ resolveActivePlannerTasks: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../jobPlannerSync", () => ({ syncJobActionTriggersStandalone: jest.fn().mockResolvedValue(undefined) }));

const db = require("../db") as {
  beginTransaction: jest.Mock;
  commitTransaction: jest.Mock;
  executeQuery: jest.Mock;
  rollbackTransaction: jest.Mock;
};
const { upsertJobInvoice } = require("./invoices") as {
  upsertJobInvoice: (req: HttpRequest, ctx: InvocationContext) => Promise<{ status?: number; jsonBody?: any }>;
};

function makeRequest(body: unknown): HttpRequest {
  return { headers: { get: () => null }, json: jest.fn().mockResolvedValue(body), query: new URLSearchParams() } as unknown as HttpRequest;
}
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

type Call = { params: Record<string, unknown>; sql: string };
const calls = (): Call[] =>
  db.executeQuery.mock.calls.map((c: unknown[]) => ({
    params: Object.fromEntries(((c[2] as { name: string; value: unknown }[] | undefined) ?? []).map((p) => [p.name, p.value])),
    sql: String(c[1]),
  }));
const callMatching = (re: RegExp): Call | undefined => calls().find((c) => re.test(c.sql));
const contractorLookups = (): Call[] => calls().filter((c) => /FROM dbo\.Contractors/.test(c.sql));

/** The invoice as the locked read of an edit finds it. */
let existing: Record<string, unknown>;

beforeEach(() => {
  jest.clearAllMocks();
  existing = {
    Amount: 100,
    ApprovedAt: null,
    ContractorID: 7,
    ContractorName: "Acme Pty Ltd",
    InvoiceNumber: "261012-IV-42-AC-1",
    JobID: 42,
    JobInvoiceID: 5,
    Status: "pending",
  };
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    if (/MAX\(Seq\)/.test(sql)) return [{ NextSeq: 1 }];
    if (/INSERT INTO JobInvoices/.test(sql)) return [{ JobInvoiceID: 5 }];
    if (/FROM dbo\.Contractors WHERE ContractorID/.test(sql)) return [{ ContractorName: "Acme Pty Ltd" }];
    if (/SELECT JobInvoiceID, JobID, InvoiceNumber, Amount/.test(sql)) return [existing];
    if (/FROM JobInvoices WHERE JobInvoiceID/.test(sql)) return [{ ContractorID: 7, JobInvoiceID: 5 }];
    return [];
  });
});

describe("creating an invoice records its contractor", () => {
  it("stores the id the request gives, with the name that came with it", async () => {
    const res = await upsertJobInvoice(makeRequest({ ContractorID: 7, ContractorName: "Acme Corp", JobID: 42 }), ctx);

    expect(res.status).toBe(200);
    const insert = callMatching(/INSERT INTO JobInvoices/)!;
    expect(insert.sql).toMatch(/\(JobID, InvoiceNumber, Seq, ContractorID, ContractorName,/);
    expect(insert.params).toMatchObject({ ContractorID: 7, ContractorName: "Acme Corp" });
    expect(insert.params.InvoiceNumber).toMatch(/^\d{6}-IV-42-AC-1$/);
  });

  it("checks the id against the contractors we have, binding it", async () => {
    await upsertJobInvoice(makeRequest({ ContractorID: 7, JobID: 42 }), ctx);

    expect(contractorLookups()).toHaveLength(1);
    expect(contractorLookups()[0].sql).toBe("SELECT ContractorName FROM dbo.Contractors WHERE ContractorID = @ContractorID");
    expect(contractorLookups()[0].params).toEqual({ ContractorID: 7 });
  });

  it("takes the contractor's own name when only the id comes: for the invoice, its number and its event", async () => {
    await upsertJobInvoice(makeRequest({ ContractorID: 7, JobID: 42 }), ctx);

    const insert = callMatching(/INSERT INTO JobInvoices/)!;
    expect(insert.params).toMatchObject({ ContractorID: 7, ContractorName: "Acme Pty Ltd" });
    expect(insert.params.InvoiceNumber).toMatch(/^\d{6}-IV-42-APL-1$/);
    expect(callMatching(/INSERT INTO JobEvents/)!.params.Text).toMatch(/ · Acme Pty Ltd/);
  });

  it("leaves the id null when only a name comes, and never looks the name up", async () => {
    await upsertJobInvoice(makeRequest({ ContractorName: "Acme Plumbing", JobID: 42 }), ctx);

    expect(callMatching(/INSERT INTO JobInvoices/)!.params).toMatchObject({ ContractorID: null, ContractorName: "Acme Plumbing" });
    expect(contractorLookups()).toHaveLength(0);
  });

  it("stores neither when the request names no contractor", async () => {
    await upsertJobInvoice(makeRequest({ JobID: 42 }), ctx);

    expect(callMatching(/INSERT INTO JobInvoices/)!.params).toMatchObject({ ContractorID: null, ContractorName: null });
    expect(contractorLookups()).toHaveLength(0);
  });

  it("an id of null says there is none", async () => {
    await upsertJobInvoice(makeRequest({ ContractorID: null, ContractorName: "Acme Plumbing", JobID: 42 }), ctx);

    expect(callMatching(/INSERT INTO JobInvoices/)!.params).toMatchObject({ ContractorID: null, ContractorName: "Acme Plumbing" });
    expect(contractorLookups()).toHaveLength(0);
  });

  it("refuses an id that isn't a contractor before starting, so nothing is written", async () => {
    db.executeQuery.mockImplementation(async () => []);

    const res = await upsertJobInvoice(makeRequest({ ContractorID: 999, JobID: 42 }), ctx);

    expect(res).toEqual({ jsonBody: { error: "ContractorID does not match a contractor" }, status: 400 });
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(callMatching(/INSERT INTO JobInvoices/)).toBeUndefined();
  });

  it.each([0, -3, 1.5, "7", 2147483648, true])("refuses %p as an id without looking anything up", async (bad) => {
    const res = await upsertJobInvoice(makeRequest({ ContractorID: bad, JobID: 42 }), ctx);

    expect(res).toEqual({ jsonBody: { error: "ContractorID must be a whole number" }, status: 400 });
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("gives the invoice back with its contractor id", async () => {
    const res = await upsertJobInvoice(makeRequest({ ContractorID: 7, JobID: 42 }), ctx);

    const reload = callMatching(/FROM JobInvoices WHERE JobInvoiceID/)!;
    expect(reload.sql).toMatch(/ContractorName, ContractorID,/);
    expect(res.jsonBody.invoice.ContractorID).toBe(7);
  });
});

describe("editing who an invoice is from", () => {
  const edit = (body: Record<string, unknown>) => upsertJobInvoice(makeRequest({ JobInvoiceID: 5, ...body }), ctx);
  const setClause = (): string => callMatching(/UPDATE JobInvoices SET (?!Status)/)!.sql;

  it("reads the invoice's contractor id under the lock, with the rest", async () => {
    await edit({ Notes: "x" });

    expect(callMatching(/SELECT JobInvoiceID, JobID, InvoiceNumber, Amount/)!.sql).toMatch(/ContractorID\s+FROM JobInvoices WITH \(UPDLOCK, HOLDLOCK\)/);
  });

  it("sets the id the request gives, and the contractor's own name when none comes", async () => {
    await edit({ ContractorID: 8 });

    const update = callMatching(/UPDATE JobInvoices SET (?!Status)/)!;
    expect(update.sql).toMatch(/ContractorID = @ContractorID/);
    expect(update.params).toMatchObject({ ContractorID: 8, ContractorName: "Acme Pty Ltd" });
  });

  it("counts an id on its own as something to update", async () => {
    const res = await edit({ ContractorID: 8 });

    expect(res.status).toBe(200);
  });

  it("sets the id and the name the request gives together", async () => {
    await edit({ ContractorID: 8, ContractorName: "Beta Pty" });

    expect(callMatching(/UPDATE JobInvoices SET (?!Status)/)!.params).toMatchObject({ ContractorID: 8, ContractorName: "Beta Pty" });
  });

  it("an id of null clears it, and leaves the name alone", async () => {
    await edit({ ContractorID: null });

    const update = callMatching(/UPDATE JobInvoices SET (?!Status)/)!;
    expect(update.sql).toMatch(/ContractorID = @ContractorID/);
    expect(update.params.ContractorID).toBeNull();
    expect(update.sql).not.toMatch(/ContractorName/);
  });

  it("a new name with no id clears the id the invoice had: it would point at the wrong contractor", async () => {
    await edit({ ContractorName: "Beta Pty" });

    expect(setClause()).toMatch(/ContractorName = @ContractorName, ContractorID = NULL WHERE/);
  });

  it("clears the id in the same statement as the new name, so the two never disagree", async () => {
    await edit({ ContractorName: "Beta Pty" });

    expect(calls().filter((c) => /UPDATE JobInvoices SET (?!Status)/.test(c.sql))).toHaveLength(1);
  });

  it("the same name again changes nothing about the id", async () => {
    await edit({ ContractorName: "Acme Pty Ltd" });

    expect(setClause()).not.toMatch(/ContractorID/);
  });

  it("a new name on an invoice that has no id has no id to clear", async () => {
    existing.ContractorID = null;

    await edit({ ContractorName: "Beta Pty" });

    expect(setClause()).not.toMatch(/ContractorID/);
  });

  it("a name and an id together don't clear anything", async () => {
    await edit({ ContractorID: 8, ContractorName: "Beta Pty" });

    expect(setClause()).not.toMatch(/ContractorID = NULL/);
  });

  it("an edit that doesn't touch the contractor leaves both alone", async () => {
    await edit({ Notes: "typo" });

    expect(setClause()).not.toMatch(/Contractor/);
    expect(contractorLookups()).toHaveLength(0);
  });

  it("never works the id out from the name", async () => {
    await edit({ ContractorName: "Beta Pty" });

    expect(contractorLookups()).toHaveLength(0);
  });

  it("refuses an id that isn't a contractor before starting, so nothing changes", async () => {
    db.executeQuery.mockImplementation(async () => []);

    const res = await edit({ ContractorID: 999 });

    expect(res).toEqual({ jsonBody: { error: "ContractorID does not match a contractor" }, status: 400 });
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });

  it("refuses a bad id without looking anything up", async () => {
    const res = await edit({ ContractorID: "8" });

    expect(res).toEqual({ jsonBody: { error: "ContractorID must be a whole number" }, status: 400 });
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});
