/// <reference types="jest" />
// REV-07: a changed email or ABN arriving from the myBuildings sync starts the SECA-04 hold, attributed to
// the sync rather than a person, so nobody can tick past it as its editor. DB and myBuildings mocked.
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn().mockResolvedValue({ id: "connection" }),
  executeQuery: jest.fn(),
}));
jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return { ...actual, extractToken: jest.fn().mockReturnValue("mock-token"), requireRole: jest.fn().mockResolvedValue(null) };
});
jest.mock("../mybuildings-client", () => ({ createOrUpdateContractors: jest.fn(), fetchAllContractors: jest.fn() }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn() } }));

const db = require("../db") as { executeQuery: jest.Mock };
const myb = require("../mybuildings-client") as { fetchAllContractors: jest.Mock };
type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ jsonBody?: unknown; status?: number }>;
require("./contractors");
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
const hit = app.http.mock.calls.find((c: unknown[]) => c[0] === "syncContractors");
const sync = (hit?.[1] as { handler: Handler }).handler;
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const request = { headers: { get: () => null }, query: new URLSearchParams() } as unknown as HttpRequest;

const updates = () => db.executeQuery.mock.calls.filter((c: unknown[]) => /UPDATE Contractors SET/.test(String(c[1])));
const param = (call: unknown[], name: string) => (call[2] as { name: string; value: unknown }[]).find((p) => p.name === name)?.value;

function existingContractor(row: { ABN: string | null; EmailAddress: string | null }) {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => (/SELECT Id, EmailAddress, ABN FROM Contractors/.test(sql) ? [{ Id: 1, ...row }] : []));
}

beforeEach(() => jest.clearAllMocks());

describe("syncContractors", () => {
  it("starts the hold, attributed to the sync, when the email changes", async () => {
    existingContractor({ ABN: "123", EmailAddress: "old@acme.example" });
    myb.fetchAllContractors.mockResolvedValue([{ ABN: "123", ContractorID: 3, ContractorName: "Acme", EmailAddress: "new@evil.example" }]);
    expect((await sync(request, ctx)).status).toBe(200);
    const [update] = updates();
    expect(String(update[1])).toMatch(/ContactChangedAt=SYSUTCDATETIME\(\), ContactChangedBy=@ChangedBy, ContactChangedByOid=NULL/);
    expect(String(update[1])).toMatch(/ContactConfirmedAt=NULL/);
    expect(param(update, "ChangedBy")).toBe("myBuildings sync");
  });

  it("starts the hold when the ABN changes", async () => {
    existingContractor({ ABN: "123", EmailAddress: "a@acme.example" });
    myb.fetchAllContractors.mockResolvedValue([{ ABN: "999", ContractorID: 3, EmailAddress: "a@acme.example" }]);
    await sync(request, ctx);
    expect(String(updates()[0][1])).toMatch(/ContactChangedAt=SYSUTCDATETIME\(\)/);
  });

  it("leaves the hold alone when neither changed (a case or space difference is not a change)", async () => {
    existingContractor({ ABN: "123", EmailAddress: "A@Acme.example" });
    myb.fetchAllContractors.mockResolvedValue([{ ABN: "123 ", ContractorID: 3, EmailAddress: "a@acme.example " }]);
    await sync(request, ctx);
    expect(String(updates()[0][1])).not.toMatch(/ContactChangedAt/);
    expect(param(updates()[0], "ChangedBy")).toBeUndefined();
  });
});
