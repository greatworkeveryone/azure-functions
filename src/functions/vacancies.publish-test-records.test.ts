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
const handlerOf = (name: string) => (app.http.mock.calls.find((c: unknown[]) => c[0] === name)?.[1] as { handler: Handler }).handler;
const publish = handlerOf("publishVacancy");
const create = handlerOf("createVacancy");
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

  it("treats a vacancy of a test tenancy as a test vacancy, whatever its own flag says (D9 review)", async () => {
    db.executeQuery.mockResolvedValueOnce([{ ...ROW, IsTest: false, TenancyIsTest: true }]);
    const res = await publish(request, ctx);
    expect(res).toEqual({ jsonBody: { code: "TEST_RECORD", error: "Not sent: test record" }, status: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.executeQuery.mock.calls[0][1]).toMatch(/t\.IsTest AS TenancyIsTest[\s\S]*LEFT JOIN dbo\.Tenants t ON t\.TenantId = v\.TenancyId/);
  });

  it("publishes a real vacancy", async () => {
    db.executeQuery.mockResolvedValueOnce([{ ...ROW, IsTest: false }]).mockResolvedValueOnce([{ ...ROW, Status: "published" }]);
    const res = await publish(request, ctx);
    expect(res.status ?? 200).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith("https://wp.example/wp-json/wp/v2/tenancy", expect.objectContaining({ method: "POST" }));
  });
});

describe("createVacancy and test records (D9 review)", () => {
  const creating = (body: Record<string, unknown>) => ({ headers: { get: () => null }, json: async () => body }) as unknown as HttpRequest;
  const insertedIsTest = () => {
    const insert = db.executeQuery.mock.calls.find((call) => String(call[1]).includes("INSERT INTO dbo.Vacancies"));
    return (insert?.[2] as { name: string; value: unknown }[]).find((p) => p.name === "IsTest")?.value;
  };

  it("makes a vacancy of a test tenancy a test vacancy", async () => {
    db.executeQuery.mockResolvedValueOnce([{ IsTest: true }]).mockResolvedValueOnce([{ ...ROW, IsTest: true }]);
    expect((await create(creating({ tenancyId: 9, title: "Suite 9" }), ctx)).status).toBe(201);
    expect(db.executeQuery.mock.calls[0][1]).toContain("FROM dbo.Tenants WHERE TenantId = @Id");
    expect(db.executeQuery.mock.calls[0][2]).toEqual([expect.objectContaining({ name: "Id", value: 9 })]);
    expect(insertedIsTest()).toBe(true);
  });

  it("leaves a real tenancy's vacancy real, and asks nothing when there is no tenancy", async () => {
    db.executeQuery.mockResolvedValueOnce([{ IsTest: false }]).mockResolvedValueOnce([{ ...ROW }]);
    await create(creating({ tenancyId: 9, title: "Suite 9" }), ctx);
    expect(insertedIsTest()).toBe(false);

    db.executeQuery.mockReset().mockResolvedValueOnce([{ ...ROW }]);
    await create(creating({ title: "Suite 10" }), ctx);
    expect(db.executeQuery).toHaveBeenCalledTimes(1);
    expect(insertedIsTest()).toBe(false);
  });
});
