import { HttpRequest, type InvocationContext } from "@azure/functions";
import { AppRole } from "../auth";
import { suggest } from "../contractorSuggestions/suggest";
import { closeConnection, createRequestConnection } from "../db";
import { suggestContractors } from "./suggestContractors";

jest.mock("@azure/functions", () => ({
  ...jest.requireActual("@azure/functions"),
  app: { http: jest.fn() },
}));
let roles: string[] = [AppRole.FACILITIES];
let token: string | null = "token";
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: () => token,
  requireRole: async (_r: unknown, allowed: string[]) =>
    jest.requireActual("../auth").rolesPassGate(roles, allowed) ? null : { status: 403 },
  rolesForRequest: async () => roles,
  verifiedIdentityFromRequest: async () => ({ email: "fay@example.com", name: "Fay Facilities", oid: "fay-oid" }),
}));
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn(async () => ({})),
  executeQuery: jest.fn(),
}));
jest.mock("../contractorSuggestions/suggest", () => ({
  ...jest.requireActual("../contractorSuggestions/suggest"),
  suggest: jest.fn(),
}));

const suggestMock = jest.mocked(suggest);
const warn = jest.fn();
const context = { error: jest.fn(), warn } as unknown as InvocationContext;
const request = (body: unknown, headers: Record<string, string> = {}) =>
  new HttpRequest({
    body: { string: typeof body === "string" ? body : JSON.stringify(body) },
    headers: { "Content-Type": "application/json", ...headers },
    method: "POST",
    url: "http://localhost/api/suggestContractors",
  });

const RESULT = {
  buildingId: 10,
  candidates: [{ certificate: { daysToExpiry: 12, status: "expiring" as const }, contractorId: 1, name: "Alpha", rank: 1, reasons: [{ caution: false, text: "Covers Electrical" }], score: 36 }],
  context: "quote_request" as const,
  featureSchemaVersion: "cs-features@1",
  jobId: 7,
  rankerVersion: "rules@1",
  suggestionSetId: 55,
  trade: "Electrical",
};

beforeEach(() => {
  jest.clearAllMocks();
  roles = [AppRole.FACILITIES];
  token = "token";
  delete process.env.CONTRACTOR_RANKER;
  suggestMock.mockResolvedValue({ ok: true, value: RESULT });
});

describe("suggestContractors: who may ask", () => {
  it.each([AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.CFO, AppRole.DIRECTOR, AppRole.ADMIN])(
    "lets %s ask, the same people who may request quotes",
    async (role) => {
      roles = [role];
      expect((await suggestContractors(request({ context: "quote_request", jobId: 7 }), context)).status).toBe(200);
    },
  );

  it("refuses a baseline user before reading or logging anything", async () => {
    roles = [AppRole.USER];
    expect((await suggestContractors(request({ context: "quote_request", jobId: 7 }), context)).status).toBe(403);
    expect(createRequestConnection).not.toHaveBeenCalled();
    expect(suggestMock).not.toHaveBeenCalled();
  });

  it("refuses a request with no token", async () => {
    token = null;
    expect((await suggestContractors(request({ context: "assign", jobId: 7 }), context)).status).toBe(401);
    expect(suggestMock).not.toHaveBeenCalled();
  });
});

describe("suggestContractors: input", () => {
  it.each([
    ["not JSON", "not json"],
    ["not an object", "[1]"],
    ["no context", { jobId: 7 }],
    ["an unknown context", { context: "approve", jobId: 7 }],
    ["neither a job nor a building", { context: "assign" }],
    ["both a job and a building", { buildingId: 10, context: "assign", jobId: 7, trade: "Lifts" }],
    ["a job id that is not a whole number above zero", { context: "assign", jobId: 0 }],
    ["a building without a trade", { buildingId: 10, context: "assign" }],
    ["a trade that is not a servicing trade", { buildingId: 10, context: "assign", trade: "Common Areas" }],
    ["building zero", { buildingId: 0, context: "assign", trade: "Lifts" }],
  ])("is a 400 for %s, before the database is opened", async (_label, body) => {
    expect((await suggestContractors(request(body), context)).status).toBe(400);
    expect(createRequestConnection).not.toHaveBeenCalled();
  });

  it("accepts a building and a trade, in any case, including a manual (negative) building", async () => {
    expect((await suggestContractors(request({ buildingId: -7, context: "assign", trade: "hvac / mechanical" }), context)).status).toBe(200);
    expect(suggestMock.mock.calls[0][1]).toEqual({ buildingId: -7, context: "assign", trade: "HVAC / mechanical" });
  });
});

describe("suggestContractors: the answer", () => {
  it("returns the set id, the ranker version and the candidates, uncached", async () => {
    const response = await suggestContractors(request({ context: "quote_request", jobId: 7 }), context);
    expect(response.status).toBe(200);
    expect(response.headers).toEqual({ "Cache-Control": "no-store" });
    expect(response.jsonBody).toEqual(RESULT);
  });

  it("takes who is asking from the verified token, never from the body", async () => {
    await suggestContractors(request({ actor: "forged", actorOid: "forged-oid", context: "quote_request", jobId: 7 }), context);
    expect(suggestMock.mock.calls[0][2]).toEqual({ name: "Fay Facilities", oid: "fay-oid" });
  });

  it("is a 404 when the job is not there", async () => {
    suggestMock.mockResolvedValue({ error: "Job not found", ok: false, status: 404 });
    const response = await suggestContractors(request({ context: "assign", jobId: 404 }), context);
    expect(response.status).toBe(404);
    expect(response.jsonBody).toEqual({ error: "Job not found" });
  });

  it("closes its connection and answers 500 without the detail when the work fails", async () => {
    suggestMock.mockRejectedValue(new Error("Invalid object name 'dbo.ContractorSuggestionSets'"));
    const response = await suggestContractors(request({ context: "assign", jobId: 7 }), context);
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.jsonBody)).not.toMatch(/ContractorSuggestionSets/);
    expect(closeConnection).toHaveBeenCalledTimes(1);
  });
});

describe("suggestContractors: the ranker and test data", () => {
  it("uses the rules ranker by default", async () => {
    await suggestContractors(request({ context: "assign", jobId: 7 }), context);
    expect(suggestMock.mock.calls[0][3].ranker.version).toBe("rules@1");
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to the rules ranker and warns when CONTRACTOR_RANKER names nothing registered", async () => {
    process.env.CONTRACTOR_RANKER = "learned";
    await suggestContractors(request({ context: "assign", jobId: 7 }), context);
    expect(suggestMock.mock.calls[0][3].ranker.version).toBe("rules@1");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('CONTRACTOR_RANKER "learned"'));
  });

  it("counts test records only for an admin who turned Show test data on", async () => {
    roles = [AppRole.ADMIN];
    await suggestContractors(request({ context: "assign", jobId: 7 }, { "x-show-test-data": "1" }), context);
    expect(suggestMock.mock.calls[0][3].showTest).toBe(true);
    roles = [AppRole.FACILITIES];
    await suggestContractors(request({ context: "assign", jobId: 7 }, { "x-show-test-data": "1" }), context);
    expect(suggestMock.mock.calls[1][3].showTest).toBe(false);
    roles = [AppRole.ADMIN];
    await suggestContractors(request({ context: "assign", jobId: 7 }), context);
    expect(suggestMock.mock.calls[2][3].showTest).toBe(false);
  });
});
