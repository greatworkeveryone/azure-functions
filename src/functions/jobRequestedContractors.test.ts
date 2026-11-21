/// <reference types="jest" />
// FX15: adding a contractor moves nothing; marking the request sent (bulk or
// by the tick) logs one quote_requested event and moves New -> Quote once. DB
// is mocked; the real status helper runs, so its SQL is what is asserted.
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn() } };
});
jest.mock("../db", () => ({
  beginTransaction: jest.fn(),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn(),
  createRequestConnection: jest.fn(),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn(),
}));
jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ jsonBody: { error: "Error" }, status: 500 }),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    requireRole: jest.fn().mockResolvedValue(null),
    unauthorizedResponse: jest.fn().mockReturnValue({ jsonBody: { error: "Unauthorized" }, status: 401 }),
    verifiedIdentityFromRequest: jest.fn(),
  };
});

const auth = require("../auth") as { requireRole: jest.Mock; verifiedIdentityFromRequest: jest.Mock };
const db = require("../db") as { beginTransaction: jest.Mock; commitTransaction: jest.Mock; createRequestConnection: jest.Mock; executeQuery: jest.Mock; rollbackTransaction: jest.Mock };
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
const { ACTION_ROLES } = require("../action-roles") as { ACTION_ROLES: { addQuoteContractor: { gate: unknown } } };
require("./jobRequestedContractors");

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ jsonBody?: any; status?: number }>;
// Captured at import: clearAllMocks would wipe the registrations.
const registered = new Map<string, { authLevel: string; handler: Handler; methods: string[] }>(
  app.http.mock.calls.map((c: unknown[]) => [c[0] as string, c[1] as { authLevel: string; handler: Handler; methods: string[] }]),
);
const handlerOf = (name: string): Handler => registered.get(name)!.handler;
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const post = (name: string, body: unknown) => handlerOf(name)({ json: jest.fn().mockResolvedValue(body) } as unknown as HttpRequest, ctx);

type Route = { match: RegExp; rows?: Record<string, unknown>[] };
function mockSql(routes: Route[]): void {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => routes.find((r) => r.match.test(sql))?.rows ?? []);
}
const sqls = () => db.executeQuery.mock.calls.map((c: unknown[]) => String(c[1]));
const params = (re: RegExp) => {
  const call = db.executeQuery.mock.calls.find((c: unknown[]) => re.test(String(c[1])))!;
  return Object.fromEntries((call[2] as { name: string; value: unknown }[]).map((p) => [p.name, p.value]));
};
const jobStatus = (status: string): Route => ({ match: /SELECT Status, AwaitingRole FROM Jobs/, rows: [{ AwaitingRole: "facilities", Status: status }] });
const statusMoves = () => sqls().filter((s) => /UPDATE Jobs\s+SET Status/.test(s)).length;
const sentEvents = () => sqls().filter((s) => /'quote_requested'/.test(s)).length;

beforeEach(() => {
  jest.clearAllMocks();
  auth.requireRole.mockResolvedValue(null);
  auth.verifiedIdentityFromRequest.mockResolvedValue({ email: "fi@example.com", name: "Fi Facilities", oid: "o" });
  db.createRequestConnection.mockResolvedValue({ id: "connection" });
  db.beginTransaction.mockResolvedValue(undefined);
  db.commitTransaction.mockResolvedValue(undefined);
  db.rollbackTransaction.mockResolvedValue(undefined);
});

describe("addJobRequestedContractor", () => {
  it("adds the contractor and never moves the job, first or later", async () => {
    mockSql([{ match: /OUTPUT INSERTED\.ID/, rows: [{ ID: 4 }] }, { match: /WHERE ID = @ID/, rows: [{ ID: 4 }] }, jobStatus("New")]);
    const res = await post("addJobRequestedContractor", { addedBy: "Fi", contractorName: "Acme", jobId: 9 });
    expect(res.status).toBe(200);
    expect(statusMoves()).toBe(0);
    expect(sqls().some((s) => /SELECT Status, AwaitingRole/.test(s))).toBe(false);
    expect(sqls().some((s) => /UPDATE Jobs SET LastModifiedDate/.test(s))).toBe(true);
    expect(params(/'contractor_requested'/).Text).toBe("Added Acme to the quote request");
  });
  it("stamps the verified name, never one from the body (SECA-07)", async () => {
    mockSql([{ match: /OUTPUT INSERTED\.ID/, rows: [{ ID: 4 }] }, { match: /WHERE ID = @ID/, rows: [{ ID: 4 }] }]);
    await post("addJobRequestedContractor", { addedBy: "Jo Director", contractorName: "Acme", jobId: 9 });
    expect(params(/INSERT INTO JobRequestedContractors/).AddedBy).toBe("Fi Facilities");
    expect(params(/'contractor_requested'/).CreatedBy).toBe("Fi Facilities");
  });
  it("400s without a contractor name", async () => {
    expect((await post("addJobRequestedContractor", { jobId: 9 })).status).toBe(400);
  });
});

describe("markRequestedContractorsSent", () => {
  const found = { match: /SELECT ID, ContractorName/, rows: [{ ContractorName: "Acme", ID: 1 }, { ContractorName: "Bolt", ID: 2 }] };
  const stored = { match: /SELECT\s+ID, JobID, ContractorID/, rows: [{ ID: 1, RequestSent: true }, { ID: 2, RequestSent: true }] };

  it("is registered, POST and anonymous-level like its siblings", () => {
    expect(registered.get("markRequestedContractorsSent")).toMatchObject({ authLevel: "anonymous", methods: ["POST"] });
  });
  it("marks the ids sent, logs one event naming them, moves New to Quote, returns the rows", async () => {
    mockSql([found, stored, jobStatus("New")]);
    const res = await post("markRequestedContractorsSent", { ids: [1, 2], jobId: 9 });
    expect(res).toEqual({ jsonBody: { requestedContractors: stored.rows }, status: 200 });
    expect(sqls().some((s) => /SET RequestSent = 1/.test(s) && /ID IN \(1,2\)/.test(s))).toBe(true);
    expect(sentEvents()).toBe(1);
    expect(params(/'quote_requested'/)).toMatchObject({ CreatedBy: "Fi Facilities", Text: "Quote request sent to Acme, Bolt" });
    expect(statusMoves()).toBe(1);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });
  it("still logs the send but leaves status alone when the job is already Quote", async () => {
    mockSql([found, stored, jobStatus("Quote")]);
    const res = await post("markRequestedContractorsSent", { ids: [1, 2], jobId: 9 });
    expect(res.status).toBe(200);
    expect(sentEvents()).toBe(1);
    expect(statusMoves()).toBe(0);
  });
  it.each([
    ["no ids", { ids: [], jobId: 9 }],
    ["too many ids", { ids: Array.from({ length: 51 }, (_, i) => i + 1), jobId: 9 }],
    ["non-integer id", { ids: [1, "2"], jobId: 9 }],
    ["ids not an array", { ids: 1, jobId: 9 }],
    ["no jobId", { ids: [1] }],
  ])("400s: %s", async (_n, body) => {
    expect((await post("markRequestedContractorsSent", body)).status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
  it("404s and writes nothing when any id is not this job's", async () => {
    mockSql([{ match: /SELECT ID, ContractorName/, rows: [{ ContractorName: "Acme", ID: 1 }] }]);
    const res = await post("markRequestedContractorsSent", { ids: [1, 2], jobId: 9 });
    expect(res.status).toBe(404);
    expect(sqls().some((s) => /SET RequestSent/.test(s))).toBe(false);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(db.rollbackTransaction).toHaveBeenCalled();
  });
  it("returns the gate's refusal untouched and uses the shared gate", async () => {
    const denied = { jsonBody: { error: "Forbidden" }, status: 403 };
    auth.requireRole.mockResolvedValue(denied);
    expect(await post("markRequestedContractorsSent", { ids: [1], jobId: 9 })).toBe(denied);
    expect(auth.requireRole).toHaveBeenCalledWith(expect.anything(), ACTION_ROLES.addQuoteContractor.gate);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });
});

describe("toggleRequestedContractorSent", () => {
  const row = (sent: boolean): Route => ({ match: /SELECT ContractorName, RequestSent/, rows: [{ ContractorName: "Acme", RequestSent: sent }] });
  const after: Route = { match: /SELECT\s+ID, JobID, ContractorID/, rows: [{ ID: 1, RequestSent: true }] };

  it("first send (false to true) logs the event and moves New to Quote; response shape unchanged", async () => {
    mockSql([row(false), after, jobStatus("New")]);
    const res = await post("toggleRequestedContractorSent", { id: 1, jobId: 9, requestSent: true });
    expect(res).toEqual({ jsonBody: { requestedContractor: after.rows![0] }, status: 200 });
    expect(sentEvents()).toBe(1);
    expect(statusMoves()).toBe(1);
  });
  it("true to true changes nothing about status", async () => {
    mockSql([row(true), after, jobStatus("New")]);
    await post("toggleRequestedContractorSent", { id: 1, jobId: 9, requestSent: true });
    expect(sentEvents()).toBe(0);
    expect(statusMoves()).toBe(0);
  });
  it("un-ticking never touches status or events", async () => {
    mockSql([row(true), after, jobStatus("Quote")]);
    const res = await post("toggleRequestedContractorSent", { id: 1, jobId: 9, requestSent: false });
    expect(res.status).toBe(200);
    expect(sentEvents()).toBe(0);
    expect(statusMoves()).toBe(0);
    expect(sqls().some((s) => /SELECT Status, AwaitingRole/.test(s))).toBe(false);
  });
  it("no-ops the status move when the job is already Quote", async () => {
    mockSql([row(false), after, jobStatus("Quote")]);
    await post("toggleRequestedContractorSent", { id: 1, jobId: 9, requestSent: true });
    expect(statusMoves()).toBe(0);
  });
  it("404s when the row is not this job's", async () => {
    mockSql([]);
    expect((await post("toggleRequestedContractorSent", { id: 1, jobId: 9, requestSent: true })).status).toBe(404);
  });
  it("400s on a non-boolean requestSent and refuses when gated", async () => {
    expect((await post("toggleRequestedContractorSent", { id: 1, jobId: 9, requestSent: "yes" })).status).toBe(400);
    auth.requireRole.mockResolvedValue({ status: 403 });
    expect((await post("toggleRequestedContractorSent", { id: 1, jobId: 9, requestSent: true })).status).toBe(403);
  });
});
