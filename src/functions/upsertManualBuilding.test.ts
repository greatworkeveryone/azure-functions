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
    errorResponse: jest.fn().mockReturnValue({ jsonBody: { error: "Error" }, status: 500 }),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    requireRole: jest.fn().mockResolvedValue(null),
    unauthorizedResponse: jest.fn().mockReturnValue({ jsonBody: { error: "Unauthorized" }, status: 401 }),
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

jest.mock("./getBuildings", () => ({ clearBuildingsCache: jest.fn() }));

import { AppRole } from "../auth";
import { clearBuildingsCache } from "./getBuildings";
import { upsertManualBuilding } from "./upsertManualBuilding";

type Row = Record<string, unknown>;
type SqlCall = [unknown, string, Array<{ name: string; value: unknown }>?];

const db = require("../db") as {
  beginTransaction: jest.Mock;
  commitTransaction: jest.Mock;
  createRequestConnection: jest.Mock;
  executeQuery: jest.Mock;
  rollbackTransaction: jest.Mock;
};
const auth = require("../auth") as { requireRole: jest.Mock };
const context = new InvocationContext();

function route(routes: Array<{ match: RegExp; rows?: Row[] }>): void {
  db.executeQuery.mockImplementation(async (_connection: unknown, sql: string) => {
    const hit = routes.find((r) => r.match.test(sql));
    return hit?.rows ?? [];
  });
}
const queries = (match: RegExp): SqlCall[] => (db.executeQuery.mock.calls as SqlCall[]).filter(([, sql]) => match.test(sql));
const paramsOf = (call: SqlCall): Row => Object.fromEntries((call[2] ?? []).map((p) => [p.name, p.value]));
const post = (value: unknown): HttpRequest => ({ json: async () => value, query: new URLSearchParams() }) as unknown as HttpRequest;

const stored = (overrides: Row = {}): Row => ({
  Active: true,
  BuildingAddress: "24 Gunbar St",
  BuildingID: -4,
  BuildingName: "24 Gunbar St",
  Category: "residence",
  OwnerName: "Paolo",
  ...overrides,
});

/** The next free manual id is -4; the readback after the write returns `after`. */
function routeCreate(after: Row = stored()): void {
  route([
    { match: /SELECT[^]*MIN\(BuildingID\)/i, rows: [{ NextId: -4 }] },
    { match: /INSERT INTO dbo\.Buildings/i, rows: [{ BuildingID: -4 }] },
    { match: /SELECT[^]*FROM dbo\.Buildings[^]*WHERE BuildingID = @BuildingId/i, rows: [after] },
  ]);
}

beforeEach(() => {
  jest.clearAllMocks();
  auth.requireRole.mockResolvedValue(null);
  db.executeQuery.mockResolvedValue([]);
});

describe("upsertManualBuilding: create", () => {
  it("creates a residence with its owner, under the next free negative id", async () => {
    routeCreate();

    const response = await upsertManualBuilding(post({ category: "residence", name: "24 Gunbar St", ownerName: "Paolo" }), context);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({
      building: { active: true, address: "24 Gunbar St", buildingId: -4, category: "residence", name: "24 Gunbar St", ownerName: "Paolo" },
      created: true,
    });
    const [insert] = queries(/INSERT INTO dbo\.Buildings/i);
    expect(paramsOf(insert)).toMatchObject({ Category: "residence", Name: "24 Gunbar St", OwnerName: "Paolo" });
    expect(db.commitTransaction).toHaveBeenCalled();
    expect(clearBuildingsCache).toHaveBeenCalled();
  });

  it("allocates ids among manual buildings only, below the lowest one in use", async () => {
    routeCreate();

    await upsertManualBuilding(post({ category: "commercial", name: "Melville St Flats" }), context);

    const [pick] = queries(/MIN\(BuildingID\)/i);
    expect(pick[1]).toMatch(/WHERE\s+BuildingID\s*<=\s*0/i);
    expect(paramsOf(queries(/INSERT INTO dbo\.Buildings/i)[0]).NewId).toBe(-4);
  });

  it("defaults the category to commercial and the address to the name", async () => {
    routeCreate(stored({ BuildingName: "Melville St Flats", Category: "commercial", OwnerName: null }));

    await upsertManualBuilding(post({ name: "Melville St Flats" }), context);

    expect(paramsOf(queries(/INSERT INTO dbo\.Buildings/i)[0])).toMatchObject({
      Address: "Melville St Flats",
      Category: "commercial",
      OwnerName: null,
    });
  });

  it("trims the owner and stores a blank owner as NULL", async () => {
    routeCreate();
    await upsertManualBuilding(post({ category: "residence", name: "A", ownerName: "  Carlo  " }), context);
    expect(paramsOf(queries(/INSERT INTO dbo\.Buildings/i)[0]).OwnerName).toBe("Carlo");

    db.executeQuery.mockClear();
    routeCreate();
    await upsertManualBuilding(post({ category: "residence", name: "B", ownerName: "   " }), context);
    expect(paramsOf(queries(/INSERT INTO dbo\.Buildings/i)[0]).OwnerName).toBeNull();
  });

  it("refuses a second building with the same name, because work requests are matched by name", async () => {
    route([{ match: /BuildingName\s*=\s*@Name/i, rows: [{ BuildingID: 12 }] }]);

    const response = await upsertManualBuilding(post({ category: "residence", name: "24 Gunbar St" }), context);

    expect(response.status).toBe(409);
    expect(queries(/INSERT INTO dbo\.Buildings/i)).toHaveLength(0);
    expect(db.rollbackTransaction).toHaveBeenCalled();
  });
});

describe("upsertManualBuilding: validation", () => {
  it.each([
    ["an unknown category", { category: "villa", name: "A" }],
    ["a category in the wrong case", { category: "Residence", name: "A" }],
    ["a non-string category", { category: 2, name: "A" }],
    ["a missing name", { category: "residence" }],
    ["a blank name", { category: "residence", name: "   " }],
    ["a name over 255 characters", { category: "residence", name: "x".repeat(256) }],
    ["an address over 500 characters", { address: "x".repeat(501), category: "residence", name: "A" }],
    ["an owner over 200 characters", { category: "residence", name: "A", ownerName: "x".repeat(201) }],
    ["a non-string owner", { category: "residence", name: "A", ownerName: 5 }],
    ["a myBuildings building (positive id)", { buildingId: 12, category: "residence", name: "A" }],
    ["a fractional id", { buildingId: -1.5, category: "residence", name: "A" }],
  ])("refuses %s with a 400 and touches nothing", async (_label, body) => {
    const response = await upsertManualBuilding(post(body), context);

    expect(response.status).toBe(400);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
    expect(db.executeQuery).not.toHaveBeenCalled();
    expect(clearBuildingsCache).not.toHaveBeenCalled();
  });

  it("says in plain words which category values are allowed", async () => {
    const response = await upsertManualBuilding(post({ category: "villa", name: "A" }), context);

    expect((response.jsonBody as { error: string }).error).toBe("category must be commercial or residence");
  });

  it("accepts an owner of exactly 200 characters and a name of exactly 255", async () => {
    routeCreate();
    const response = await upsertManualBuilding(post({ category: "residence", name: "n".repeat(255), ownerName: "o".repeat(200) }), context);
    expect(response.status).toBe(200);
  });

  it("refuses a body that is not a JSON object", async () => {
    const response = await upsertManualBuilding(
      { json: async () => { throw new SyntaxError("bad"); }, query: new URLSearchParams() } as unknown as HttpRequest,
      context,
    );
    expect(response.status).toBe(400);
  });
});

describe("upsertManualBuilding: update", () => {
  it("changes the category and owner of an existing manual building and leaves other fields alone", async () => {
    route([
      { match: /UPDLOCK/i, rows: [stored({ Category: "commercial", OwnerName: null })] },
      { match: /SELECT[^]*FROM dbo\.Buildings[^]*WHERE BuildingID = @BuildingId/i, rows: [stored({ BuildingID: -2, OwnerName: "Paolo" })] },
    ]);

    const response = await upsertManualBuilding(post({ buildingId: -2, category: "residence", ownerName: "Paolo" }), context);

    expect(response.status).toBe(200);
    expect((response.jsonBody as { created: boolean }).created).toBe(false);
    const [update] = queries(/UPDATE dbo\.Buildings/i);
    expect(update[1]).toMatch(/Category = @Category/);
    expect(update[1]).toMatch(/OwnerName = @OwnerName/);
    expect(update[1]).not.toMatch(/BuildingName = /);
    expect(update[1]).toMatch(/BuildingID = @BuildingId\s+AND\s+BuildingID\s*<=\s*0/i);
    expect(paramsOf(update)).toMatchObject({ BuildingId: -2, Category: "residence", OwnerName: "Paolo" });
    expect(clearBuildingsCache).toHaveBeenCalled();
  });

  it("clears the owner when it is sent as null", async () => {
    route([
      { match: /UPDLOCK/i, rows: [stored()] },
      { match: /SELECT[^]*FROM dbo\.Buildings[^]*WHERE BuildingID = @BuildingId/i, rows: [stored({ OwnerName: null })] },
    ]);

    await upsertManualBuilding(post({ buildingId: -4, ownerName: null }), context);

    expect(paramsOf(queries(/UPDATE dbo\.Buildings/i)[0]).OwnerName).toBeNull();
  });

  it("is a 404 when the manual building does not exist", async () => {
    route([{ match: /UPDLOCK/i, rows: [] }]);

    const response = await upsertManualBuilding(post({ buildingId: -9, category: "residence" }), context);

    expect(response.status).toBe(404);
    expect(queries(/UPDATE dbo\.Buildings/i)).toHaveLength(0);
  });

  it("is a 400 when an update names nothing to change", async () => {
    route([{ match: /UPDLOCK/i, rows: [stored()] }]);

    const response = await upsertManualBuilding(post({ buildingId: -4 }), context);

    expect(response.status).toBe(400);
    expect(queries(/UPDATE dbo\.Buildings/i)).toHaveLength(0);
  });
});

describe("upsertManualBuilding: access", () => {
  it("is admin only, and a refusal is passed straight through", async () => {
    auth.requireRole.mockResolvedValueOnce({ jsonBody: { error: "Forbidden" }, status: 403 });

    const response = await upsertManualBuilding(post({ category: "residence", name: "A" }), context);

    expect(response.status).toBe(403);
    expect(auth.requireRole).toHaveBeenCalledWith(expect.anything(), [AppRole.ADMIN]);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });
});
