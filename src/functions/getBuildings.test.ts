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
  };
});

jest.mock("../db", () => {
  const actual = jest.requireActual("../db");
  return {
    ...actual,
    closeConnection: jest.fn(),
    createRequestConnection: jest.fn().mockResolvedValue({}),
    executeQuery: jest.fn().mockResolvedValue([]),
  };
});

jest.mock("../blob-storage", () => ({ vacanciesReadSasUrl: jest.fn((url: string) => url) }));

import { AppRole } from "../auth";
import { resetBuildingCategoryColumnProbe } from "../buildingCategoryColumn";
import { clearBuildingsCache, getBuildings } from "./getBuildings";

const db = require("../db") as { executeQuery: jest.Mock };
const auth = require("../auth") as { requireRole: jest.Mock };
const context = new InvocationContext();
const get = (query = ""): HttpRequest => ({ query: new URLSearchParams(query) }) as unknown as HttpRequest;

const row = (overrides: Record<string, unknown> = {}) => ({
  Active: true,
  BuildingID: 7,
  BuildingName: "Alpha House",
  Category: "commercial",
  OwnerName: null,
  ...overrides,
});

/** Answers the column probe with `probeLen` (null: migration 136 not applied) and the list query with `rows`. */
function serve(rows: Array<Record<string, unknown>>, probeLen: number | null = 20): void {
  db.executeQuery.mockImplementation(async (_connection: unknown, sql: string) =>
    /COL_LENGTH/i.test(sql) ? [{ Len: probeLen }] : rows,
  );
}
const listSql = (): string => {
  const call = (db.executeQuery.mock.calls as Array<[unknown, string]>).find(([, sql]) => /FROM Buildings/i.test(sql));
  return call?.[1] ?? "";
};

beforeEach(() => {
  jest.clearAllMocks();
  clearBuildingsCache();
  resetBuildingCategoryColumnProbe();
  serve([]);
  auth.requireRole.mockResolvedValue(null);
});

describe("getBuildings: category and owner (U8)", () => {
  it("selects Category and OwnerName", async () => {
    await getBuildings(get(), context);

    expect(listSql()).toMatch(/\bCategory\b/);
    expect(listSql()).toMatch(/\bOwnerName\b/);
  });

  it("returns category and ownerName on every row, commercial and residence together", async () => {
    serve([
      row(),
      row({ BuildingID: -4, BuildingName: "24 Gunbar St", Category: "residence", OwnerName: "Paolo" }),
    ]);

    const response = await getBuildings(get(), context);

    expect(response.status).toBe(200);
    const body = response.jsonBody as { buildings: Array<Record<string, unknown>>; count: number };
    expect(body.count).toBe(2);
    expect(body.buildings.map((b) => [b.BuildingID, b.Category, b.OwnerName])).toEqual([
      [7, "commercial", null],
      [-4, "residence", "Paolo"],
    ]);
  });

  it("does not filter by category: a residence is returned by the same query as everything else", async () => {
    await getBuildings(get(), context);

    expect(listSql()).not.toMatch(/WHERE[^]*\bCategory\s*(?:=|<>|!=|\bIN\b)/i);
  });

  it("serves the same fields from the cache on the next call", async () => {
    serve([row({ BuildingID: -2, Category: "residence", OwnerName: "Paolo" })]);
    await getBuildings(get(), context);
    db.executeQuery.mockClear();

    const cached = await getBuildings(get(), context);

    expect(db.executeQuery).not.toHaveBeenCalled();
    const body = cached.jsonBody as { buildings: Array<Record<string, unknown>> };
    expect(body.buildings[0]).toMatchObject({ Category: "residence", OwnerName: "Paolo" });
  });

  it("keeps its role gate: every app role may read the list, and a refusal is passed through", async () => {
    await getBuildings(get(), context);
    expect(auth.requireRole).toHaveBeenCalledWith(expect.anything(), Object.values(AppRole));

    clearBuildingsCache();
    auth.requireRole.mockResolvedValueOnce({ jsonBody: { error: "Forbidden" }, status: 403 });
    const denied = await getBuildings(get(), context);
    expect(denied.status).toBe(403);
  });
});

describe("getBuildings: before migration 136 is applied", () => {
  const oldRows = [
    { Active: true, BuildingID: 7, BuildingName: "Alpha House" },
    { Active: true, BuildingID: -1, BuildingName: "13 Seale St" },
  ];

  it("does not name Category or OwnerName, and returns every building", async () => {
    serve(oldRows, null);

    const response = await getBuildings(get(), context);

    expect(listSql()).not.toMatch(/\bCategory\b/);
    expect(listSql()).not.toMatch(/\bOwnerName\b/);
    expect(response.status).toBe(200);
    const body = response.jsonBody as { buildings: Array<Record<string, unknown>>; count: number };
    expect(body.count).toBe(2);
    expect(body.buildings.map((b) => [b.BuildingID, b.Category])).toEqual([[7, undefined], [-1, undefined]]);
  });

  it("probes again on the next cache miss, so applying 136 takes effect without a restart", async () => {
    serve(oldRows, null);
    await getBuildings(get(), context);
    expect(listSql()).not.toMatch(/\bCategory\b/);

    db.executeQuery.mockClear();
    clearBuildingsCache();
    serve([row()], 20);
    await getBuildings(get(), context);

    expect(listSql()).toMatch(/\bCategory\b/);
  });

  it("remembers a positive probe, so the column check is not repeated on every cache miss", async () => {
    serve([row()], 20);
    await getBuildings(get(), context);
    db.executeQuery.mockClear();
    clearBuildingsCache();

    await getBuildings(get(), context);

    const probes = (db.executeQuery.mock.calls as Array<[unknown, string]>).filter(([, sql]) => /COL_LENGTH/i.test(sql));
    expect(probes).toHaveLength(0);
    expect(listSql()).toMatch(/\bCategory\b/);
  });

  it("applies the same column list to a single-building lookup", async () => {
    serve([oldRows[0]], null);

    const response = await getBuildings(get("buildingId=7"), context);

    expect(listSql()).not.toMatch(/\bCategory\b/);
    expect(response.status).toBe(200);
  });
});
