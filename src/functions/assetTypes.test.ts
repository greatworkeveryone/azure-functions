/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn() } };
});

jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    requireRole: jest.fn().mockResolvedValue(null),
    unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
    verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "c@rp.com", name: "Connor", oid: "oid-1" }),
  };
});

jest.mock("../db", () => {
  const actual = jest.requireActual("../db");
  return {
    ...actual,
    beginTransaction: jest.fn().mockResolvedValue(undefined),
    closeConnection: jest.fn(),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    createRequestConnection: jest.fn().mockResolvedValue({}),
    executeQuery: jest.fn().mockResolvedValue([]),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
  };
});

import { getAssetTypes } from "./getAssetTypes";
import { upsertAssetType } from "./upsertAssetType";

type Row = Record<string, unknown>;
type Route = { match: RegExp; rows?: Row[] | ((params: Row) => Row[]); throws?: Error };
type SqlCall = [unknown, string, Array<{ name: string; value: unknown }>?];

const db = require("../db") as {
  beginTransaction: jest.Mock;
  closeConnection: jest.Mock;
  commitTransaction: jest.Mock;
  createRequestConnection: jest.Mock;
  executeQuery: jest.Mock;
  rollbackTransaction: jest.Mock;
};

const context = new InvocationContext();

function route(routes: Route[]): void {
  db.executeQuery.mockImplementation(async (_connection: unknown, sql: string, params: Array<{ name: string; value: unknown }> = []) => {
    const hit = routes.find((r) => r.match.test(sql));
    if (!hit) return [];
    if (hit.throws) throw hit.throws;
    const byName = Object.fromEntries(params.map((p) => [p.name, p.value]));
    return typeof hit.rows === "function" ? hit.rows(byName) : (hit.rows ?? []);
  });
}
const queries = (match: RegExp): SqlCall[] =>
  (db.executeQuery.mock.calls as SqlCall[]).filter(([, sql]) => match.test(sql));
const paramsOf = (call: SqlCall): Row => Object.fromEntries((call[2] ?? []).map((p) => [p.name, p.value]));
const get = (query: string): HttpRequest => ({ query: new URLSearchParams(query) }) as unknown as HttpRequest;
const post = (value: unknown): HttpRequest =>
  ({ json: async () => value, query: new URLSearchParams() }) as unknown as HttpRequest;
const errorOf = (response: { jsonBody?: unknown }): string => (response.jsonBody as { error: string }).error;

const typeRow = (overrides: Row = {}): Row => ({
  Active: true,
  AssetTypeId: 4,
  Category: "HVAC / mechanical",
  Name: "Chiller",
  SortOrder: 0,
  ...overrides,
});

const LIST = /FROM dbo\.AssetTypes t\s+(?:WHERE .*\s+)?ORDER BY t\.Category, t\.SortOrder/;
const BY_ID = /FROM dbo\.AssetTypes t (?:WITH \(UPDLOCK, ROWLOCK\) )?WHERE t\.AssetTypeId = @AssetTypeId/;
const INSERT = /INSERT INTO dbo\.AssetTypes/;
const UPDATE = /UPDATE dbo\.AssetTypes/;
const USAGE = /SELECT COUNT\(\*\) AS Total FROM dbo\.Assets WHERE AssetTypeId/;

const typesById = (byId: Record<number, Row>): Route => ({
  match: BY_ID,
  rows: (params) => (byId[params.AssetTypeId as number] ? [byId[params.AssetTypeId as number]] : []),
});

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockReset();
  db.executeQuery.mockResolvedValue([]);
  db.createRequestConnection.mockResolvedValue({});
});

describe("getAssetTypes", () => {
  it("lists active types by default, ordered by category then sortOrder", async () => {
    route([{ match: LIST, rows: [typeRow(), typeRow({ AssetTypeId: 5, Name: "Cooling tower", SortOrder: 1 })] }]);
    const response = await getAssetTypes(get(""), context);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({
      assetTypes: [
        { active: true, assetTypeId: 4, category: "HVAC / mechanical", name: "Chiller", sortOrder: 0 },
        { active: true, assetTypeId: 5, category: "HVAC / mechanical", name: "Cooling tower", sortOrder: 1 },
      ],
      count: 2,
    });
    const [select] = queries(LIST);
    expect(select[1]).toContain("t.Active = 1");
    expect(select[1]).toContain("ORDER BY t.Category, t.SortOrder, t.Name, t.AssetTypeId");
    expect(paramsOf(select)).toEqual({});
  });

  it("includes retired types on request (for the manager screen)", async () => {
    route([{ match: LIST, rows: [typeRow({ Active: false })] }]);
    const response = await getAssetTypes(get("includeInactive=true"), context);
    expect(queries(LIST)[0][1]).not.toContain("t.Active = 1");
    expect((response.jsonBody as { assetTypes: Row[] }).assetTypes[0].active).toBe(false);
  });

  it("filters by category, canonicalising it", async () => {
    await getAssetTypes(get("category=LIFTS"), context);
    const [select] = queries(LIST);
    expect(select[1]).toContain("t.Category = @Category");
    expect(paramsOf(select)).toEqual({ Category: "Lifts" });
  });

  it.each([["category=Plumbing", "Unknown category"], ["includeInactive=maybe", "includeInactive must be true or false"]])(
    "rejects ?%s",
    async (query, message) => {
      const response = await getAssetTypes(get(query), context);
      expect(response.status).toBe(400);
      expect(errorOf(response)).toContain(message);
      expect(db.createRequestConnection).not.toHaveBeenCalled();
    },
  );

  it("reports a failure as a 500", async () => {
    route([{ match: LIST, throws: new Error("boom") }]);
    const response = await getAssetTypes(get(""), context);
    expect(response.status).toBe(500);
    expect(db.closeConnection).toHaveBeenCalledTimes(1);
  });
});

describe("upsertAssetType: create", () => {
  it.each([
    [{ category: "Lifts" }, "category and name are required"],
    [{ name: "Passenger lift" }, "category and name are required"],
    [{ category: "Plumbing", name: "Tap" }, "category must be one of"],
    [{ category: "Lifts", name: "" }, "name cannot be empty"],
    [{ category: "Lifts", name: "x".repeat(101) }, "name must be at most 100"],
  ])("rejects %j before touching the database", async (payload, message) => {
    const response = await upsertAssetType(post(payload), context);
    expect(response.status).toBe(400);
    expect(errorOf(response)).toContain(message);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it("creates a type at the end of its category, stamping the manager", async () => {
    route([
      { match: INSERT, rows: [{ AssetTypeId: 40 }] },
      typesById({ 40: typeRow({ AssetTypeId: 40, Category: "Lifts", Name: "Passenger lift", SortOrder: 3 }) }),
    ]);
    const response = await upsertAssetType(post({ category: "lifts", name: " Passenger lift " }), context);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({
      assetType: { active: true, assetTypeId: 40, category: "Lifts", name: "Passenger lift", sortOrder: 3 },
      created: true,
    });
    const [insert] = queries(INSERT);
    expect(paramsOf(insert)).toEqual({ Active: true, Caller: "Connor", Category: "Lifts", Name: "Passenger lift", SortOrder: null });
    expect(insert[1]).toContain("ISNULL(@SortOrder, (SELECT ISNULL(MAX(s.SortOrder), -1) + 1 FROM dbo.AssetTypes s WHERE s.Category = @Category))");
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("answers 409 when an active type with that name already exists in the category", async () => {
    route([
      {
        match: INSERT,
        throws: Object.assign(new Error("Cannot insert duplicate key row in object 'dbo.AssetTypes' with unique index 'UX_AssetTypes_Category_Name'."), { number: 2601 }),
      },
    ]);
    const response = await upsertAssetType(post({ category: "Lifts", name: "Passenger lift" }), context);
    expect(response.status).toBe(409);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("upsertAssetType: update", () => {
  it("404s for an unknown type", async () => {
    const response = await upsertAssetType(post({ assetTypeId: 99, name: "X" }), context);
    expect(response.status).toBe(404);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it("renames and reorders", async () => {
    route([typesById({ 4: typeRow() })]);
    const response = await upsertAssetType(post({ assetTypeId: 4, name: "Water-cooled chiller", sortOrder: 2 }), context);

    expect(response.status).toBe(200);
    expect((response.jsonBody as { created: boolean }).created).toBe(false);
    const [update] = queries(UPDATE);
    expect(update[1]).toContain("UpdatedBy = @UpdatedBy");
    expect(paramsOf(update)).toMatchObject({ AssetTypeId: 4, Name: "Water-cooled chiller", SortOrder: 2, UpdatedBy: "Connor" });
    expect(queries(USAGE)).toHaveLength(0);
  });

  it("retires a type that assets still use - they keep it", async () => {
    route([typesById({ 4: typeRow() }), { match: USAGE, rows: [{ Total: 12 }] }]);
    const response = await upsertAssetType(post({ active: false, assetTypeId: 4 }), context);
    expect(response.status).toBe(200);
    expect(paramsOf(queries(UPDATE)[0])).toMatchObject({ Active: false });
    expect(queries(USAGE)).toHaveLength(0);
  });

  it("will not move a type that assets use to another category", async () => {
    route([typesById({ 4: typeRow() }), { match: USAGE, rows: [{ Total: 12 }] }]);
    const response = await upsertAssetType(post({ assetTypeId: 4, category: "Electrical" }), context);
    expect(response.status).toBe(409);
    expect(errorOf(response)).toContain("12 asset(s) use this type");
    expect(queries(UPDATE)).toHaveLength(0);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it("moves an unused type to another category", async () => {
    route([typesById({ 4: typeRow() }), { match: USAGE, rows: [{ Total: 0 }] }]);
    const response = await upsertAssetType(post({ assetTypeId: 4, category: "Electrical" }), context);
    expect(response.status).toBe(200);
    expect(paramsOf(queries(UPDATE)[0])).toMatchObject({ Category: "Electrical" });
  });

  it("does not count usage when the category is only re-sent unchanged", async () => {
    route([typesById({ 4: typeRow() })]);
    await upsertAssetType(post({ assetTypeId: 4, category: "hvac / mechanical", name: "Chiller (all)" }), context);
    expect(queries(USAGE)).toHaveLength(0);
  });

  it("rejects an update that changes nothing", async () => {
    route([typesById({ 4: typeRow() })]);
    const response = await upsertAssetType(post({ assetTypeId: 4 }), context);
    expect(response.status).toBe(400);
    expect(errorOf(response)).toBe("No fields to update");
  });

  it("answers 409 when a rename or reactivation collides with an active type", async () => {
    route([
      typesById({ 4: typeRow({ Active: false }) }),
      { match: UPDATE, throws: Object.assign(new Error("Cannot insert duplicate key row in object 'dbo.AssetTypes' with unique index 'UX_AssetTypes_Category_Name'."), { number: 2601 }) },
    ]);
    const response = await upsertAssetType(post({ active: true, assetTypeId: 4 }), context);
    expect(response.status).toBe(409);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it("reports an unexpected failure as a 500", async () => {
    route([typesById({ 4: typeRow() }), { match: UPDATE, throws: new Error("deadlock victim") }]);
    const response = await upsertAssetType(post({ assetTypeId: 4, name: "X" }), context);
    expect(response.status).toBe(500);
    expect(db.closeConnection).toHaveBeenCalledTimes(1);
  });
});
