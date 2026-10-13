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

jest.mock("../blob-storage", () => ({
  deleteBlob: jest.fn().mockResolvedValue(undefined),
  generateReadSasUrl: jest.fn((blobName: string) => `https://sas.example/${blobName}`),
  uploadBlob: jest.fn(),
}));

import { getAsset } from "./getAsset";
import { getAssets } from "./getAssets";

type Row = Record<string, unknown>;
type SqlCall = [unknown, string, Array<{ name: string; value: unknown }>?];

const db = require("../db") as {
  closeConnection: jest.Mock;
  createRequestConnection: jest.Mock;
  executeQuery: jest.Mock;
};
const auth = require("../auth") as { errorResponse: jest.Mock };

const context = new InvocationContext();

function route(routes: Array<{ match: RegExp; rows?: Row[] | ((params: Row) => Row[]); throws?: Error }>): void {
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

const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const asset = (overrides: Row = {}): Row => ({
  ArchivedAt: null,
  ArchivedBy: null,
  AssetId: 12,
  AssetTag: "CH-01",
  AssetTypeId: 4,
  AssetTypeName: "Chiller",
  AssetTypeNote: null,
  BuildingId: 1,
  Category: "HVAC / mechanical",
  CreatedAt: at("2026-10-01"),
  CreatedBy: "Sam",
  Criticality: "standard",
  ExternalId: null,
  InstallDate: null,
  LocationId: 9,
  LocationName: "Plant room",
  Make: "Daikin",
  Model: "EWAD",
  Name: "Chiller 1",
  Notes: null,
  ParentAssetId: null,
  Responsibility: "owner",
  SerialNumber: "SN1",
  ServiceContractorId: null,
  ServiceContractorName: null,
  Source: "manual",
  Specs: null,
  Status: "active",
  UpdatedAt: at("2026-10-02"),
  UpdatedBy: "Sam",
  VerifiedAt: null,
  VerifiedBy: null,
  WarrantyExpiry: null,
  ...overrides,
});

const LIST = /ORDER BY a\.BuildingId, a\.Category, a\.Name/;
const COUNT = /SELECT COUNT\(\*\) AS Total FROM dbo\.Assets a/;
const ASSET_BY_ID = /dbo\.Contractors c ON c\.ContractorID = a\.ServiceContractorId\s+WHERE a\.AssetId = @AssetId/;
const CHAIN = /WITH Chain AS/;
const PARENT = /SELECT AssetId, AssetTag, Name, Category, Status, ArchivedAt\s+FROM dbo\.Assets WHERE AssetId = @ParentAssetId/;
const CHILDREN = /WHERE ParentAssetId = @AssetId AND ArchivedAt IS NULL/;
const JOBS = /FROM dbo\.JobAssets ja/;
const FILES = /FROM dbo\.AssetAttachments aa/;

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockReset();
  db.executeQuery.mockResolvedValue([]);
  db.createRequestConnection.mockResolvedValue({});
});

describe("getAssets: query validation", () => {
  it.each([
    ["buildingId=abc", "buildingId must be an integer"],
    ["locationId=1.5", "locationId must be an integer"],
    ["category=Plumbing", "Unknown category"],
    ["status=broken", "status must be one of"],
    ["verified=maybe", "verified must be true or false"],
    ["unclassified=1", "unclassified must be true or false"],
    ["includeArchived=yes", "includeArchived must be true or false"],
  ])("rejects ?%s", async (query, message) => {
    const response = await getAssets(get(query), context);
    expect(response.status).toBe(400);
    expect((response.jsonBody as { error: string }).error).toContain(message);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });
});

describe("getAssets: filters", () => {
  it("excludes archived assets unless asked", async () => {
    await getAssets(get(""), context);
    expect(queries(LIST)[0][1]).toContain("a.ArchivedAt IS NULL");

    db.executeQuery.mockClear();
    await getAssets(get("includeArchived=true"), context);
    expect(queries(LIST)[0][1]).not.toContain("ArchivedAt IS NULL");

    db.executeQuery.mockClear();
    await getAssets(get("includeArchived=false"), context);
    expect(queries(LIST)[0][1]).toContain("a.ArchivedAt IS NULL");
  });

  it("binds every filter as a parameter and canonicalises the category", async () => {
    await getAssets(
      get("buildingId=-2&category=hvac%20%2F%20MECHANICAL&locationId=9&status=out_of_service&verified=false&unclassified=true"),
      context,
    );
    const [list] = queries(LIST);
    for (const predicate of [
      "a.BuildingId = @BuildingId",
      "a.Category = @Category",
      "a.LocationId = @LocationId",
      "a.Status = @Status",
      "a.VerifiedAt IS NULL",
      "a.AssetTypeId IS NULL",
    ]) {
      expect(list[1]).toContain(predicate);
    }
    expect(paramsOf(list)).toEqual({ BuildingId: -2, Category: "HVAC / mechanical", LocationId: 9, Status: "out_of_service" });
  });

  it("filters verified=true and unclassified=false the other way round", async () => {
    await getAssets(get("verified=true&unclassified=false"), context);
    const [list] = queries(LIST);
    expect(list[1]).toContain("a.VerifiedAt IS NOT NULL");
    expect(list[1]).toContain("a.AssetTypeId IS NOT NULL");
  });

  it("returns camelCase list items without the (large) specs column", async () => {
    // The list query does not select Specs, so its rows never carry the key.
    const listRow = (overrides: Row = {}): Row => {
      const { Specs: _specs, ...rest } = asset(overrides);
      return rest;
    };
    route([{ match: LIST, rows: [listRow(), listRow({ AssetId: 13, AssetTag: null, AssetTypeId: null, AssetTypeName: null })] }]);
    const response = await getAssets(get("buildingId=1"), context);

    expect(response.status).toBe(200);
    const payload = response.jsonBody as { assets: Row[]; count: number; total: number; truncated: boolean };
    expect(payload).toMatchObject({ count: 2, total: 2, truncated: false });
    expect(payload.assets[0]).toMatchObject({
      assetId: 12,
      assetTag: "CH-01",
      assetTypeName: "Chiller",
      buildingId: 1,
      category: "HVAC / mechanical",
      isArchived: false,
      locationName: "Plant room",
      verifiedAt: null,
    });
    expect("specs" in payload.assets[0]).toBe(false);
    expect(payload.assets[1].assetTypeId).toBeNull();
    expect(queries(LIST)[0][1]).not.toContain("a.Specs");
    expect(queries(LIST)[0][1]).toContain("TOP 5000");
  });

  it("paginates on request and reports the unpaginated total", async () => {
    route([
      { match: LIST, rows: [asset()] },
      { match: COUNT, rows: [{ Total: 41 }] },
    ]);
    const response = await getAssets(get("buildingId=1&page=2&pageSize=10"), context);

    const payload = response.jsonBody as Record<string, unknown>;
    expect(payload).toMatchObject({ count: 1, page: 2, pageSize: 10, total: 41, truncated: false });
    const [list] = queries(LIST);
    expect(list[1]).toContain("OFFSET 10 ROWS FETCH NEXT 10 ROWS ONLY");
    expect(list[1]).not.toContain("TOP 5000");
    expect(paramsOf(queries(COUNT)[0])).toEqual({ BuildingId: 1 });
  });

  it("flags truncation when the safety ceiling is hit", async () => {
    route([{ match: LIST, rows: Array.from({ length: 5000 }, (_, i) => asset({ AssetId: i + 1 })) }]);
    const response = await getAssets(get(""), context);
    expect((response.jsonBody as { truncated: boolean }).truncated).toBe(true);
  });

  it("turns a database failure into a 500 and closes the connection", async () => {
    route([{ match: LIST, throws: new Error("boom") }]);
    const response = await getAssets(get(""), context);
    expect(response.status).toBe(500);
    expect(auth.errorResponse).toHaveBeenCalled();
    expect(db.closeConnection).toHaveBeenCalledTimes(1);
  });
});

describe("getAsset", () => {
  it.each(["", "id=abc", "id=0", "id=-4"])("rejects ?%s", async (query) => {
    const response = await getAsset(get(query), context);
    expect(response.status).toBe(400);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it("404s for an unknown asset without running the follow-up queries", async () => {
    const response = await getAsset(get("id=99"), context);
    expect(response.status).toBe(404);
    expect(queries(CHAIN)).toHaveLength(0);
    expect(queries(JOBS)).toHaveLength(0);
  });

  it("assembles location path, parent, components, linked jobs and files", async () => {
    route([
      { match: ASSET_BY_ID, rows: [asset({ ParentAssetId: 3, Specs: '{"kw":410}', VerifiedAt: at("2026-10-05"), VerifiedBy: "Sam" })] },
      {
        match: CHAIN,
        rows: [
          { Active: true, Kind: "level", LocationId: 1, Name: "Level 3", SpaceType: null },
          { Active: true, Kind: "space", LocationId: 9, Name: "Plant room", SpaceType: "plant" },
        ],
      },
      { match: PARENT, rows: [{ ArchivedAt: null, AssetId: 3, AssetTag: "AHU-1", Category: "HVAC / mechanical", Name: "AHU 1", Status: "active" }] },
      { match: CHILDREN, rows: [{ ArchivedAt: null, AssetId: 20, AssetTag: null, Category: "HVAC / mechanical", Name: "Pump A", Status: "out_of_service" }] },
      {
        match: JOBS,
        rows: [{ IsArchived: false, JobID: 7, Kind: "maintenance", LinkedAt: at("2026-10-10"), LinkedBy: "Connor", Status: "Work", Title: "Annual service" }],
      },
      {
        match: FILES,
        rows: [
          { AssetId: 12, AttachedAt: at("2026-10-11"), BlobName: "asset-12/a.pdf", Comment: null, ContentType: "application/pdf", Extension: "pdf", Id: 5, MyBuildingsConfirmedAt: null, OriginalName: "manual.pdf", SizeBytes: "2048", UploadedAt: at("2026-10-11"), UploadedBy: "oid-1", UploadedByName: "Connor" },
        ],
      },
    ]);

    const response = await getAsset(get("id=12"), context);

    expect(response.status).toBe(200);
    const detail = (response.jsonBody as { asset: Row }).asset;
    expect(detail).toMatchObject({
      assetId: 12,
      children: [{ assetId: 20, isArchived: false, name: "Pump A", status: "out_of_service" }],
      linkedJobs: [{ isArchived: false, jobId: 7, kind: "maintenance", status: "Work", title: "Annual service" }],
      parent: { assetId: 3, assetTag: "AHU-1", name: "AHU 1" },
      specs: { kw: 410 },
      verifiedBy: "Sam",
    });
    expect(detail.location).toMatchObject({ kind: "space", locationId: 9, pathLabel: "Level 3 / Plant room", spaceType: "plant" });
    expect((detail.location as { path: Array<{ locationId: number }> }).path.map((p) => p.locationId)).toEqual([1, 9]);
    expect(detail.attachments).toEqual([
      expect.objectContaining({ id: 5, originalName: "manual.pdf", sasUrl: "https://sas.example/asset-12/a.pdf", sizeBytes: 2048, uploadedByName: "Connor" }),
    ]);
    expect(paramsOf(queries(CHILDREN)[0])).toEqual({ AssetId: 12 });
    expect(db.closeConnection).toHaveBeenCalledTimes(1);
  });

  it("skips the location and parent lookups for a free-standing asset", async () => {
    route([{ match: ASSET_BY_ID, rows: [asset({ LocationId: null, LocationName: null, ParentAssetId: null })] }]);
    const response = await getAsset(get("id=12"), context);
    const detail = (response.jsonBody as { asset: Row }).asset;
    expect(detail).toMatchObject({ attachments: [], children: [], linkedJobs: [], location: null, parent: null, specs: null });
    expect(queries(CHAIN)).toHaveLength(0);
    expect(queries(PARENT)).toHaveLength(0);
  });

  it("withholds the download link for a file whose blob is gone", async () => {
    route([
      { match: ASSET_BY_ID, rows: [asset()] },
      { match: FILES, rows: [{ AssetId: 12, BlobName: "asset-12/a.pdf", Id: 5, MyBuildingsConfirmedAt: at("2026-10-12"), OriginalName: "manual.pdf" }] },
    ]);
    const response = await getAsset(get("id=12"), context);
    const files = (response.jsonBody as { asset: { attachments: Array<{ sasUrl: string | null }> } }).asset.attachments;
    expect(files[0].sasUrl).toBeNull();
  });
});
