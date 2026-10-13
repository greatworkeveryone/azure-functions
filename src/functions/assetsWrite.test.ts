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

import { archiveAsset } from "./archiveAsset";
import { upsertAsset } from "./upsertAsset";
import { verifyAsset } from "./verifyAsset";

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
const post = (value: unknown): HttpRequest =>
  ({ json: async () => value, query: new URLSearchParams() }) as unknown as HttpRequest;
const notJson = (): HttpRequest =>
  ({ json: async () => { throw new SyntaxError("Unexpected token"); }, query: new URLSearchParams() }) as unknown as HttpRequest;
const errorOf = (response: { jsonBody?: unknown }): string => (response.jsonBody as { error: string }).error;

/** Serves the rows in order, repeating the last: read-before-write, then read-after-write. */
function inOrder(...rows: Row[]) {
  let served = 0;
  return () => [rows[Math.min(served++, rows.length - 1)]];
}

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
const VERIFIED = { VerifiedAt: at("2026-10-05"), VerifiedBy: "Sam" };

const ASSET_BY_ID = /dbo\.Contractors c ON c\.ContractorID = a\.ServiceContractorId\s+WHERE a\.AssetId = @AssetId/;
const BUILDING = /FROM dbo\.Buildings WHERE BuildingID/;
const LOCATION = /FROM dbo\.Locations l (?:WITH \(UPDLOCK, ROWLOCK\) )?WHERE l\.LocationId = @LocationId/;
const PARENT = /SELECT AssetId, BuildingId, ArchivedAt FROM dbo\.Assets WHERE AssetId = @ParentAssetId/;
const CYCLE = /WITH Ancestors AS \(\s+SELECT p\.AssetId/;
const CONTRACTOR = /FROM dbo\.Contractors WHERE ContractorID = @ContractorId/;
const TYPE = /FROM dbo\.AssetTypes t (?:WITH \(UPDLOCK, ROWLOCK\) )?WHERE t\.AssetTypeId = @AssetTypeId/;
const TAG_CLASH = /SELECT TOP 1 AssetId, Name FROM dbo\.Assets/;
const BY_EXTERNAL = /SELECT AssetId FROM dbo\.Assets WITH \(UPDLOCK, ROWLOCK\)\s+WHERE Source = @Source/;
const INSERT = /INSERT INTO dbo\.Assets/;
const UPDATE = /UPDATE dbo\.Assets SET/;
const COMPONENTS = /SELECT COUNT\(\*\) AS Total FROM dbo\.Assets WHERE ParentAssetId/;
const ARCHIVE = /UPDATE dbo\.Assets\s+SET ArchivedAt/;
const VERIFY = /UPDATE dbo\.Assets\s+SET VerifiedAt/;

const location = (overrides: Row = {}): Row => ({
  Active: true,
  BuildingId: 1,
  Kind: "space",
  LocationId: 9,
  Name: "Plant room",
  ParentLocationId: null,
  SortOrder: 0,
  SpaceType: "plant",
  ...overrides,
});
const type = (overrides: Row = {}): Row => ({
  Active: true,
  AssetTypeId: 4,
  Category: "HVAC / mechanical",
  Name: "Chiller",
  SortOrder: 0,
  ...overrides,
});

const NEW_ASSET = { buildingId: 1, category: "HVAC / mechanical", name: "Chiller 1" };

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockReset();
  db.executeQuery.mockResolvedValue([]);
  db.createRequestConnection.mockResolvedValue({});
});

describe("upsertAsset: request validation", () => {
  it("rejects a body that is not a JSON object", async () => {
    const response = await upsertAsset(notJson(), context);
    expect(response.status).toBe(400);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...NEW_ASSET, category: "Plumbing" }, "category must be one of"],
    [{ ...NEW_ASSET, status: "broken" }, "status must be one of"],
    [{ ...NEW_ASSET, installDate: "13/10/2026" }, "installDate must be a real date"],
    [{ ...NEW_ASSET, specs: [1] }, "specs must be a JSON object"],
    [{ buildingId: 1, category: "Lifts" }, "name is required"],
    [{ buildingId: 1, name: "Lift" }, "category is required"],
    [{ category: "Lifts", name: "Lift" }, "buildingId is required"],
    [{ ...NEW_ASSET, externalId: "MB-1" }, "only applies to imported assets"],
    [{ ...NEW_ASSET, source: "mybuildings" }, "externalId is required"],
  ])("rejects %j before touching the database", async (payload, message) => {
    const response = await upsertAsset(post(payload), context);
    expect(response.status).toBe(400);
    expect(errorOf(response)).toContain(message);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });
});

describe("upsertAsset: create", () => {
  const happy = (): Route[] => [
    { match: BUILDING, rows: [{ BuildingID: 1 }] },
    { match: INSERT, rows: [{ AssetId: 30 }] },
    { match: ASSET_BY_ID, rows: [asset({ AssetId: 30 })] },
  ];

  it("creates with defaults, stamping the creator, in one transaction", async () => {
    route(happy());
    const response = await upsertAsset(post(NEW_ASSET), context);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({ asset: { assetId: 30 }, created: true });
    const [insert] = queries(INSERT);
    expect(paramsOf(insert)).toMatchObject({
      AssetTag: null,
      BuildingId: 1,
      Caller: "Connor",
      Category: "HVAC / mechanical",
      Criticality: "standard",
      ExternalId: null,
      Name: "Chiller 1",
      Responsibility: "owner",
      Source: "manual",
      Status: "active",
      Verify: false,
    });
    expect(db.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
    expect(db.closeConnection).toHaveBeenCalledTimes(1);
  });

  it("maps a complete payload onto the columns", async () => {
    route([
      { match: LOCATION, rows: [location()] },
      { match: PARENT, rows: [{ ArchivedAt: null, AssetId: 3, BuildingId: 1 }] },
      { match: CONTRACTOR, rows: [{ ContractorID: 8 }] },
      { match: TYPE, rows: [type()] },
      ...happy(),
    ]);
    await upsertAsset(
      post({
        ...NEW_ASSET,
        assetTag: "CH-09",
        assetTypeId: 4,
        assetTypeNote: "  ",
        criticality: "critical",
        installDate: "2024-02-29",
        locationId: 9,
        make: "Daikin",
        model: "EWAD",
        notes: "Roof plant",
        parentAssetId: 3,
        responsibility: "shared",
        serialNumber: "SN9",
        serviceContractorId: 8,
        specs: { capacityKw: 410, refrigerant: "R134a" },
        status: "out_of_service",
        warrantyExpiry: "2029-02-28",
      }),
      context,
    );
    expect(paramsOf(queries(INSERT)[0])).toMatchObject({
      AssetTag: "CH-09",
      AssetTypeId: 4,
      AssetTypeNote: null,
      Criticality: "critical",
      InstallDate: at("2024-02-29"),
      LocationId: 9,
      Make: "Daikin",
      Model: "EWAD",
      Notes: "Roof plant",
      ParentAssetId: 3,
      Responsibility: "shared",
      SerialNumber: "SN9",
      ServiceContractorId: 8,
      Specs: '{"capacityKw":410,"refrigerant":"R134a"}',
      Status: "out_of_service",
      WarrantyExpiry: at("2029-02-28"),
    });
  });

  it("verifies on the spot when asked", async () => {
    route(happy());
    await upsertAsset(post({ ...NEW_ASSET, verified: true }), context);
    const [insert] = queries(INSERT);
    expect(paramsOf(insert).Verify).toBe(true);
    expect(insert[1]).toContain("CASE WHEN @Verify = 1 THEN SYSUTCDATETIME() END");
  });

  it.each([
    ["an unknown building", [], {}, 400, "Unknown building"],
    ["an unknown location", [{ match: BUILDING, rows: [{ BuildingID: 1 }] }], { locationId: 9 }, 400, "Unknown location"],
    [
      "a location in another building",
      [{ match: BUILDING, rows: [{ BuildingID: 1 }] }, { match: LOCATION, rows: [location({ BuildingId: 2 })] }],
      { locationId: 9 },
      400,
      "Location belongs to a different building",
    ],
    [
      "an inactive location",
      [{ match: BUILDING, rows: [{ BuildingID: 1 }] }, { match: LOCATION, rows: [location({ Active: false })] }],
      { locationId: 9 },
      400,
      "Location is inactive",
    ],
    ["an unknown parent asset", [{ match: BUILDING, rows: [{ BuildingID: 1 }] }], { parentAssetId: 3 }, 400, "Unknown parent asset"],
    [
      "a parent in another building",
      [{ match: BUILDING, rows: [{ BuildingID: 1 }] }, { match: PARENT, rows: [{ ArchivedAt: null, AssetId: 3, BuildingId: 2 }] }],
      { parentAssetId: 3 },
      400,
      "Parent asset belongs to a different building",
    ],
    [
      "an archived parent",
      [{ match: BUILDING, rows: [{ BuildingID: 1 }] }, { match: PARENT, rows: [{ ArchivedAt: at("2026-09-01"), AssetId: 3, BuildingId: 1 }] }],
      { parentAssetId: 3 },
      400,
      "Parent asset is archived",
    ],
    ["an unknown contractor", [{ match: BUILDING, rows: [{ BuildingID: 1 }] }], { serviceContractorId: 8 }, 400, "Unknown service contractor"],
    ["an unknown asset type", [{ match: BUILDING, rows: [{ BuildingID: 1 }] }], { assetTypeId: 4 }, 400, "Unknown asset type"],
    [
      "an inactive asset type",
      [{ match: BUILDING, rows: [{ BuildingID: 1 }] }, { match: TYPE, rows: [type({ Active: false })] }],
      { assetTypeId: 4 },
      400,
      "That asset type is inactive",
    ],
    [
      "an asset type from another category",
      [{ match: BUILDING, rows: [{ BuildingID: 1 }] }, { match: TYPE, rows: [type({ Category: "Lifts", Name: "Passenger lift" })] }],
      { assetTypeId: 4 },
      400,
      'Asset type "Passenger lift" belongs to Lifts, not HVAC / mechanical',
    ],
    [
      "a tag already in use in the building",
      [{ match: BUILDING, rows: [{ BuildingID: 1 }] }, { match: TAG_CLASH, rows: [{ AssetId: 7, Name: "Chiller 2" }] }],
      { assetTag: "CH-01" },
      409,
      'Asset tag "CH-01" is already used by "Chiller 2" (asset 7) in this building',
    ],
  ] as Array<[string, Route[], Row, number, string]>)("refuses %s and writes nothing", async (_label, routes, extra, status, message) => {
    route(routes);
    const response = await upsertAsset(post({ ...NEW_ASSET, ...extra }), context);

    expect(response.status).toBe(status);
    expect(errorOf(response)).toContain(message);
    expect(queries(INSERT)).toHaveLength(0);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("still answers 409 when the tag index catches a race the pre-check missed", async () => {
    route([
      { match: BUILDING, rows: [{ BuildingID: 1 }] },
      {
        match: INSERT,
        throws: Object.assign(new Error("Cannot insert duplicate key row in object 'dbo.Assets' with unique index 'UX_Assets_Building_Tag'."), { number: 2601 }),
      },
    ]);
    const response = await upsertAsset(post({ ...NEW_ASSET, assetTag: "CH-01" }), context);
    expect(response.status).toBe(409);
    expect(errorOf(response)).toContain("asset tag");
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it("answers 409 when the external id index catches a duplicate import", async () => {
    route([
      { match: BUILDING, rows: [{ BuildingID: 1 }] },
      {
        match: INSERT,
        throws: Object.assign(new Error("Cannot insert duplicate key row in object 'dbo.Assets' with unique index 'UX_Assets_Source_External'."), { number: 2601 }),
      },
    ]);
    const response = await upsertAsset(post({ ...NEW_ASSET, externalId: "MB-1", source: "mybuildings" }), context);
    expect(response.status).toBe(409);
    expect(errorOf(response)).toContain("external id");
  });

  it("reports an unexpected failure as a 500 after rolling back", async () => {
    route([{ match: BUILDING, rows: [{ BuildingID: 1 }] }, { match: INSERT, throws: new Error("deadlock victim") }]);
    const response = await upsertAsset(post(NEW_ASSET), context);
    expect(response.status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.closeConnection).toHaveBeenCalledTimes(1);
  });
});

describe("upsertAsset: update", () => {
  const updating = (current: Row, extras: Route[] = []): Route[] => [
    ...extras,
    { match: ASSET_BY_ID, rows: inOrder(current, current) },
  ];

  it("404s for an unknown asset", async () => {
    const response = await upsertAsset(post({ assetId: 99, notes: "x" }), context);
    expect(response.status).toBe(404);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it("refuses to edit an archived asset", async () => {
    route(updating(asset({ ArchivedAt: at("2026-10-01") })));
    const response = await upsertAsset(post({ assetId: 12, notes: "x" }), context);
    expect(response.status).toBe(409);
    expect(errorOf(response)).toContain("archived");
    expect(queries(UPDATE)).toHaveLength(0);
  });

  it("patches only what was sent, stamping the editor", async () => {
    route(updating(asset()));
    const response = await upsertAsset(post({ assetId: 12, notes: "Serviced Oct", serialNumber: null }), context);

    expect(response.status).toBe(200);
    expect((response.jsonBody as { created: boolean }).created).toBe(false);
    const [update] = queries(UPDATE);
    expect(update[1]).toContain("Notes = @Notes");
    expect(update[1]).toContain("SerialNumber = @SerialNumber");
    expect(update[1]).toContain("UpdatedAt = SYSUTCDATETIME(), UpdatedBy = @UpdatedBy");
    expect(update[1]).not.toContain("Name = @Name");
    expect(update[1]).not.toContain("Category = @Category");
    expect(paramsOf(update)).toMatchObject({ AssetId: 12, Notes: "Serviced Oct", SerialNumber: null, UpdatedBy: "Connor" });
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("writes dates as UTC midnight and specs as JSON (null clears)", async () => {
    route(updating(asset()));
    await upsertAsset(post({ assetId: 12, installDate: "2024-02-29", specs: { kw: 410 }, warrantyExpiry: null }), context);
    expect(paramsOf(queries(UPDATE)[0])).toMatchObject({ InstallDate: at("2024-02-29"), Specs: '{"kw":410}', WarrantyExpiry: null });

    db.executeQuery.mockClear();
    route(updating(asset()));
    await upsertAsset(post({ assetId: 12, specs: null }), context);
    expect(paramsOf(queries(UPDATE)[0]).Specs).toBeNull();
  });

  it("rejects an update that changes nothing", async () => {
    route(updating(asset()));
    const response = await upsertAsset(post({ assetId: 12 }), context);
    expect(response.status).toBe(400);
    expect(errorOf(response)).toBe("No fields to update");
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it("never moves an asset between buildings or rewrites its provenance", async () => {
    const imported = asset({ ExternalId: "MB-1", Source: "mybuildings" });
    route(updating(imported));
    const moved = await upsertAsset(post({ assetId: 12, buildingId: 2 }), context);
    expect(errorOf(moved)).toContain("different building");
    const resourced = await upsertAsset(post({ assetId: 12, source: "manual" }), context);
    expect(errorOf(resourced)).toContain("source cannot be changed");
    const reid = await upsertAsset(post({ assetId: 12, externalId: "MB-2", source: "mybuildings" }), context);
    expect(errorOf(reid)).toContain("externalId cannot be changed");
    expect(queries(UPDATE)).toHaveLength(0);
  });

  it("refuses to make an asset its own parent or ancestor", async () => {
    route(
      updating(asset(), [
        { match: PARENT, rows: [{ ArchivedAt: null, AssetId: 40, BuildingId: 1 }] },
        { match: CYCLE, rows: [{ AssetId: 12 }] },
      ]),
    );
    const self = await upsertAsset(post({ assetId: 12, parentAssetId: 12 }), context);
    expect(errorOf(self)).toContain("its own parent");

    const loop = await upsertAsset(post({ assetId: 12, parentAssetId: 40 }), context);
    expect(loop.status).toBe(400);
    expect(errorOf(loop)).toContain("its own ancestor");
    expect(queries(UPDATE)).toHaveLength(0);
  });

  it("re-parents when there is no cycle", async () => {
    route(
      updating(asset(), [
        { match: PARENT, rows: [{ ArchivedAt: null, AssetId: 40, BuildingId: 1 }] },
        { match: CYCLE, rows: [] },
      ]),
    );
    const response = await upsertAsset(post({ assetId: 12, parentAssetId: 40 }), context);
    expect(response.status).toBe(200);
    expect(paramsOf(queries(UPDATE)[0])).toMatchObject({ ParentAssetId: 40 });
  });

  it("does not flag the asset's own tag as a clash, and names the holder otherwise", async () => {
    route(updating(asset(), [{ match: TAG_CLASH, rows: [] }]));
    const same = await upsertAsset(post({ assetId: 12, assetTag: "CH-01", notes: "x" }), context);
    expect(same.status).toBe(200);
    expect(queries(TAG_CLASH)).toHaveLength(0);

    route(updating(asset(), [{ match: TAG_CLASH, rows: [{ AssetId: 7, Name: "Chiller 2" }] }]));
    const clash = await upsertAsset(post({ assetId: 12, assetTag: "CH-02" }), context);
    expect(clash.status).toBe(409);
    expect(errorOf(clash)).toContain('"Chiller 2" (asset 7)');
    expect(paramsOf(queries(TAG_CLASH)[0])).toMatchObject({ AssetId: 12, AssetTag: "CH-02", BuildingId: 1 });
  });

  it("keeps the category and its asset type together", async () => {
    route(updating(asset(), [{ match: TYPE, rows: [type()] }]));
    const orphaned = await upsertAsset(post({ assetId: 12, category: "Electrical" }), context);
    expect(orphaned.status).toBe(400);
    expect(errorOf(orphaned)).toContain('Asset type "Chiller" belongs to HVAC / mechanical, not Electrical');

    const cleared = await upsertAsset(post({ assetId: 12, assetTypeId: null, category: "Electrical" }), context);
    expect(cleared.status).toBe(200);
  });

  it("does not demand an active type when the asset keeps the one it has", async () => {
    route(updating(asset(), [{ match: TYPE, rows: [type({ Active: false })] }]));
    const response = await upsertAsset(post({ assetId: 12, assetTypeId: 4, notes: "x" }), context);
    expect(response.status).toBe(200);
  });
});

describe("upsertAsset: verification", () => {
  const verifiedAsset = asset(VERIFIED);
  const run = async (current: Row, patch: Row, extras: Route[] = []) => {
    db.executeQuery.mockClear();
    route([...extras, { match: ASSET_BY_ID, rows: inOrder(current, current) }]);
    const response = await upsertAsset(post({ assetId: 12, ...patch }), context);
    expect(response.status).toBe(200);
    return queries(UPDATE)[0][1];
  };

  it.each([
    ["location", { locationId: 10 }, [{ match: LOCATION, rows: [location({ LocationId: 10 })] }]],
    ["category", { assetTypeId: null, category: "Electrical" }, []],
    ["asset type", { assetTypeId: 5 }, [{ match: TYPE, rows: [type({ AssetTypeId: 5, Name: "Pump" })] }]],
    ["asset type note", { assetTypeNote: "Chilled water pump" }, []],
    ["make", { make: "Carrier" }, []],
    ["model", { model: "X" }, []],
    ["serial number", { serialNumber: "SN2" }, []],
  ] as Array<[string, Row, Route[]]>)("clears the stamp when the %s changes", async (_label, patch, extras) => {
    const sql = await run(verifiedAsset, patch, extras);
    expect(sql).toContain("VerifiedAt = NULL, VerifiedBy = NULL");
  });

  it.each([
    ["name", { name: "Chiller One" }],
    ["notes", { notes: "Serviced" }],
    ["status", { status: "out_of_service" }],
    ["criticality", { criticality: "critical" }],
    ["tag", { assetTag: "CH-02" }],
    ["specs", { specs: { kw: 1 } }],
    ["install date", { installDate: "2024-01-31" }],
    ["responsibility", { responsibility: "tenant" }],
  ] as Array<[string, Row]>)("keeps the stamp when only the %s changes", async (_label, patch) => {
    const sql = await run(verifiedAsset, patch);
    expect(sql).not.toContain("VerifiedAt");
    expect(sql).not.toContain("VerifiedBy");
  });

  it("keeps the stamp when identity fields are re-sent unchanged", async () => {
    const sql = await run(verifiedAsset, { category: "HVAC / mechanical", make: "Daikin", model: "EWAD", notes: "x", serialNumber: "SN1" });
    expect(sql).not.toContain("VerifiedAt");
  });

  it("re-stamps with the caller when an identity change is verified in the same request", async () => {
    const sql = await run(verifiedAsset, { make: "Carrier", verified: true });
    expect(sql).toContain("VerifiedAt = SYSUTCDATETIME(), VerifiedBy = @UpdatedBy");
    expect(sql).not.toContain("VerifiedAt = NULL");
    expect(paramsOf(queries(UPDATE)[0]).UpdatedBy).toBe("Connor");
  });

  it("verifies an unverified asset with nothing else to change", async () => {
    const sql = await run(asset(), { verified: true });
    expect(sql).toContain("UPDATE dbo.Assets SET UpdatedAt = SYSUTCDATETIME(), UpdatedBy = @UpdatedBy, VerifiedAt = SYSUTCDATETIME(), VerifiedBy = @UpdatedBy");
  });

  it("leaves an unverified asset unverified when its identity changes", async () => {
    const sql = await run(asset(), { make: "Carrier" });
    expect(sql).not.toContain("VerifiedAt");
  });

  it("treats verified: false as 'nothing requested'", async () => {
    db.executeQuery.mockClear();
    route([{ match: ASSET_BY_ID, rows: inOrder(verifiedAsset, verifiedAsset) }]);
    const response = await upsertAsset(post({ assetId: 12, verified: false }), context);
    expect(response.status).toBe(400);
    expect(errorOf(response)).toBe("No fields to update");
  });
});

describe("upsertAsset: imported assets (source + externalId)", () => {
  const IMPORT = { ...NEW_ASSET, externalId: "MB-1", source: "mybuildings" };
  const imported = asset({ AssetId: 12, ExternalId: "MB-1", Source: "mybuildings" });

  it("updates in place when the external id is already known", async () => {
    route([
      { match: BY_EXTERNAL, rows: [{ AssetId: 12 }] },
      { match: ASSET_BY_ID, rows: inOrder(imported, imported) },
    ]);
    const response = await upsertAsset(post({ ...IMPORT, name: "Chiller (re-imported)" }), context);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({ asset: { assetId: 12, externalId: "MB-1", source: "mybuildings" }, created: false });
    expect(queries(INSERT)).toHaveLength(0);
    expect(paramsOf(queries(BY_EXTERNAL)[0])).toEqual({ ExternalId: "MB-1", Source: "mybuildings" });
    expect(paramsOf(queries(UPDATE)[0])).toMatchObject({ AssetId: 12, Name: "Chiller (re-imported)" });
  });

  it("creates when the external id is new, recording the provenance", async () => {
    route([
      { match: BUILDING, rows: [{ BuildingID: 1 }] },
      { match: INSERT, rows: [{ AssetId: 31 }] },
      { match: ASSET_BY_ID, rows: [asset({ AssetId: 31, ExternalId: "MB-1", Source: "mybuildings" })] },
    ]);
    const response = await upsertAsset(post(IMPORT), context);

    expect(response.jsonBody).toMatchObject({ asset: { assetId: 31, externalId: "MB-1", source: "mybuildings" }, created: true });
    expect(paramsOf(queries(INSERT)[0])).toMatchObject({ ExternalId: "MB-1", Source: "mybuildings", Verify: false });
  });

  it("will not touch an imported asset that has since been archived", async () => {
    const archived = asset({ ArchivedAt: at("2026-10-01"), ExternalId: "MB-1", Source: "mybuildings" });
    route([
      { match: BY_EXTERNAL, rows: [{ AssetId: 12 }] },
      { match: ASSET_BY_ID, rows: [archived] },
    ]);
    const response = await upsertAsset(post(IMPORT), context);
    expect(response.status).toBe(409);
    expect(queries(INSERT)).toHaveLength(0);
    expect(queries(UPDATE)).toHaveLength(0);
  });

  it("does not look an asset up by external id when assetId is given", async () => {
    route([{ match: ASSET_BY_ID, rows: inOrder(imported, imported) }]);
    await upsertAsset(post({ assetId: 12, name: "Renamed" }), context);
    expect(queries(BY_EXTERNAL)).toHaveLength(0);
  });
});

describe("archiveAsset", () => {
  const archivedRow = asset({ ArchivedAt: at("2026-10-13"), ArchivedBy: "Connor" });

  it.each([[{}, "assetId is required"], [{ assetId: "12" }, "assetId must be an integer"]])("rejects %j", async (payload, message) => {
    const response = await archiveAsset(post(payload), context);
    expect(response.status).toBe(400);
    expect(errorOf(response)).toContain(message);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it("404s for an unknown asset", async () => {
    const response = await archiveAsset(post({ assetId: 99 }), context);
    expect(response.status).toBe(404);
  });

  it("archives, stamping who and when, and returns the archived asset", async () => {
    route([
      { match: ASSET_BY_ID, rows: inOrder(asset(), archivedRow) },
      { match: COMPONENTS, rows: [{ Total: 0 }] },
    ]);
    const response = await archiveAsset(post({ assetId: 12 }), context);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({ asset: { archivedBy: "Connor", assetId: 12, isArchived: true } });
    const [update] = queries(ARCHIVE);
    expect(update[1]).toContain("ArchivedAt = SYSUTCDATETIME()");
    expect(paramsOf(update)).toEqual({ AssetId: 12, Caller: "Connor" });
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("refuses while live components remain, so none is left under an archived parent", async () => {
    route([
      { match: ASSET_BY_ID, rows: [asset()] },
      { match: COMPONENTS, rows: [{ Total: 3 }] },
    ]);
    const response = await archiveAsset(post({ assetId: 12 }), context);
    expect(response.status).toBe(409);
    expect(errorOf(response)).toContain("3 active component(s)");
    expect(queries(ARCHIVE)).toHaveLength(0);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it("is idempotent for an asset that is already archived", async () => {
    route([{ match: ASSET_BY_ID, rows: [archivedRow] }]);
    const response = await archiveAsset(post({ assetId: 12 }), context);
    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({ asset: { isArchived: true } });
    expect(queries(ARCHIVE)).toHaveLength(0);
    expect(queries(COMPONENTS)).toHaveLength(0);
  });
});

describe("verifyAsset", () => {
  it("404s for an unknown asset", async () => {
    const response = await verifyAsset(post({ assetId: 99 }), context);
    expect(response.status).toBe(404);
  });

  it("refuses an archived asset", async () => {
    route([{ match: ASSET_BY_ID, rows: [asset({ ArchivedAt: at("2026-10-01") })] }]);
    const response = await verifyAsset(post({ assetId: 12 }), context);
    expect(response.status).toBe(409);
    expect(queries(VERIFY)).toHaveLength(0);
  });

  it("stamps the verifier from the token, never from the body", async () => {
    route([{ match: ASSET_BY_ID, rows: inOrder(asset(), asset({ VerifiedAt: at("2026-10-13"), VerifiedBy: "Connor" })) }]);
    const response = await verifyAsset(post({ assetId: 12, verifiedAt: "1999-01-01", verifiedBy: "Mallory" }), context);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({ asset: { assetId: 12, verifiedAt: "2026-10-13T00:00:00.000Z", verifiedBy: "Connor" } });
    const [update] = queries(VERIFY);
    expect(update[1]).toContain("VerifiedAt = SYSUTCDATETIME()");
    expect(paramsOf(update)).toEqual({ AssetId: 12, Caller: "Connor" });
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("re-verifies an already verified asset (moves the stamp)", async () => {
    route([{ match: ASSET_BY_ID, rows: [asset(VERIFIED)] }]);
    const response = await verifyAsset(post({ assetId: 12 }), context);
    expect(response.status).toBe(200);
    expect(queries(VERIFY)).toHaveLength(1);
  });
});
