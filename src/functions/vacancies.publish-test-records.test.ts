/// <reference types="jest" />
// D9: a test vacancy never reaches the website.
import type { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({ closeConnection: jest.fn(), createRequestConnection: jest.fn().mockResolvedValue({}), executeQuery: jest.fn() }));
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: jest.fn().mockReturnValue("tok"),
  requireRole: jest.fn().mockResolvedValue(null),
  verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "a@rp", name: "Ann", oid: "ann-oid" }),
}));

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status?: number; jsonBody?: unknown }>;
require("./vacancies");
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
const publish = (app.http.mock.calls.find((c: unknown[]) => c[0] === "publishVacancy")?.[1] as { handler: Handler }).handler;
const db = require("../db") as { executeQuery: jest.Mock };

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const request = { headers: { get: () => null }, json: async () => ({ id: 4 }) } as unknown as HttpRequest;
const fetchMock = jest.fn();
const ROW = { AdditionalDetails: "[]", BuildingName: "Tower", Id: 4, Images: "[]", SlotImages: "{}", Status: "draft", Title: "Suite 4" };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.WORDPRESS_API_URL = "https://wp.example/wp-json";
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockResolvedValue({ json: async () => ({ id: 77, slug: "suite-4" }), ok: true, text: async () => "" });
});

describe("publishVacancy and test records", () => {
  it("says 'Not sent: test record' (409) and never calls WordPress for a test vacancy", async () => {
    db.executeQuery.mockResolvedValueOnce([{ ...ROW, IsTest: true }]);
    const res = await publish(request, ctx);
    expect(res).toEqual({ jsonBody: { code: "TEST_RECORD", error: "Not sent: test record" }, status: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.executeQuery).toHaveBeenCalledTimes(1);
  });

  it("publishes a real vacancy", async () => {
    db.executeQuery.mockResolvedValueOnce([{ ...ROW, IsTest: false }]).mockResolvedValueOnce([{ ...ROW, Status: "published" }]);
    const res = await publish(request, ctx);
    expect(res.status ?? 200).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith("https://wp.example/wp-json/wp/v2/tenancy", expect.objectContaining({ method: "POST" }));
  });
});
