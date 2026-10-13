/// <reference types="jest" />
import {
  ASSET_CATEGORIES,
  AssetIdentity,
  Parsed,
  assetIdentityFromRow,
  assetRowToApi,
  assetTypeRowToApi,
  attachmentRowToApi,
  identityChanged,
  isValidIsoDate,
  linkedJobRowToApi,
  locationChainToApi,
  locationRowToApi,
  normaliseAssetCategory,
  parseAssetIdInput,
  parseAssetInput,
  parseAssetTypeInput,
  parseJobAssetInput,
  parseLocationInput,
  parseQueryBool,
  parseQueryInt,
  precheckAssetInput,
  resolveVerification,
  uniqueViolationName,
  validateAssetCreate,
  validateLocationCreate,
} from "../assetRegister";

function valueOf<T>(result: Parsed<T>): T {
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.value;
}
function errorOf(result: Parsed<unknown>): string {
  if (result.ok) throw new Error("expected an error");
  return result.error;
}

describe("normaliseAssetCategory", () => {
  it("returns the canonical spelling regardless of case and padding", () => {
    expect(normaliseAssetCategory("  hvac / MECHANICAL ")).toBe("HVAC / mechanical");
    expect(normaliseAssetCategory("fire & life safety")).toBe("Fire & life safety");
  });

  it("knows every category it lists", () => {
    for (const category of ASSET_CATEGORIES) expect(normaliseAssetCategory(category)).toBe(category);
  });

  it("rejects anything outside the list", () => {
    expect(normaliseAssetCategory("Plumbing")).toBeNull();
    expect(normaliseAssetCategory("")).toBeNull();
  });
});

describe("isValidIsoDate", () => {
  it.each(["2026-10-13", "2024-02-29", "1999-12-31"])("accepts %s", (value) => {
    expect(isValidIsoDate(value)).toBe(true);
  });

  it.each(["2026-02-30", "2025-02-29", "2026-13-01", "13/10/2026", "13-Oct-26", "2026-1-5", "0206-10-13", ""])(
    "rejects %s",
    (value) => {
      expect(isValidIsoDate(value)).toBe(false);
    },
  );
});

describe("parseAssetInput", () => {
  it("accepts a full body, trims text and normalises the category", () => {
    const input = valueOf(
      parseAssetInput({
        assetTag: " CH-01 ",
        assetTypeId: 4,
        assetTypeNote: "  ",
        buildingId: -1,
        category: "hvac / mechanical",
        criticality: "critical",
        externalId: "MB-77",
        installDate: "2024-02-29",
        locationId: 9,
        make: "Daikin",
        name: " Chiller 1 ",
        notes: "Roof plant",
        parentAssetId: null,
        responsibility: "shared",
        serialNumber: "SN1",
        serviceContractorId: 12,
        source: "mybuildings",
        specs: { kw: 410 },
        status: "out_of_service",
        verified: true,
        warrantyExpiry: null,
      }),
    );
    expect(input).toEqual({
      assetTag: "CH-01",
      assetTypeId: 4,
      assetTypeNote: null,
      buildingId: -1,
      category: "HVAC / mechanical",
      criticality: "critical",
      externalId: "MB-77",
      installDate: "2024-02-29",
      locationId: 9,
      make: "Daikin",
      name: "Chiller 1",
      notes: "Roof plant",
      parentAssetId: null,
      responsibility: "shared",
      serialNumber: "SN1",
      serviceContractorId: 12,
      source: "mybuildings",
      specs: { kw: 410 },
      status: "out_of_service",
      verified: true,
      warrantyExpiry: null,
    });
  });

  it("keeps only the keys that were sent (patch semantics)", () => {
    expect(valueOf(parseAssetInput({ assetId: 3, notes: null }))).toEqual({ assetId: 3, notes: null });
    expect(valueOf(parseAssetInput({}))).toEqual({});
  });

  it("ignores unknown keys", () => {
    expect(valueOf(parseAssetInput({ assetId: 3, ArchivedAt: "now", verifiedBy: "Mallory" }))).toEqual({ assetId: 3 });
  });

  it.each([
    [{ category: "Plumbing" }, "category must be one of"],
    [{ category: 4 }, "category must be a string"],
    [{ status: "broken" }, "status must be one of"],
    [{ responsibility: "landlord" }, "responsibility must be one of"],
    [{ criticality: "high" }, "criticality must be one of"],
    [{ source: "excel" }, "source must be one of"],
    [{ installDate: "13/10/2026" }, "installDate must be a real date"],
    [{ warrantyExpiry: "2026-02-30" }, "warrantyExpiry must be a real date"],
    [{ name: "" }, "name cannot be empty"],
    [{ name: null }, "name cannot be null"],
    [{ name: "x".repeat(201) }, "name must be at most 200"],
    [{ assetTag: "x".repeat(41) }, "assetTag must be at most 40"],
    [{ notes: "x".repeat(2001) }, "notes must be at most 2000"],
    [{ assetTypeNote: "x".repeat(201) }, "assetTypeNote must be at most 200"],
    [{ externalId: "x".repeat(51) }, "externalId must be at most 50"],
    [{ locationId: 0 }, "locationId must be an integer"],
    [{ locationId: 1.5 }, "locationId must be an integer"],
    [{ parentAssetId: "3" }, "parentAssetId must be an integer"],
    [{ assetId: -2 }, "assetId must be an integer"],
    [{ specs: [1, 2] }, "specs must be a JSON object"],
    [{ specs: "kw=1" }, "specs must be a JSON object"],
    [{ specs: { blob: "x".repeat(17_000) } }, "specs is too large"],
    [{ verified: "yes" }, "verified must be true or false"],
  ])("rejects %j", (body, message) => {
    expect(errorOf(parseAssetInput(body as Record<string, unknown>))).toContain(message);
  });
});

describe("validateAssetCreate", () => {
  const base = { buildingId: 1, category: "Lifts" as const, name: "Lift A" };

  it("requires buildingId, name and category", () => {
    expect(validateAssetCreate({ category: base.category, name: base.name })).toContain("buildingId");
    expect(validateAssetCreate({ buildingId: 1, category: base.category })).toContain("name");
    expect(validateAssetCreate({ buildingId: 1, name: base.name })).toContain("category");
    expect(validateAssetCreate(base)).toBeNull();
  });

  it("ties externalId to imported sources", () => {
    expect(validateAssetCreate({ ...base, externalId: "MB-1" })).toContain("only applies to imported");
    expect(validateAssetCreate({ ...base, source: "mybuildings" })).toContain("externalId is required");
    expect(validateAssetCreate({ ...base, source: "mybuildings", externalId: "MB-1" })).toBeNull();
    expect(validateAssetCreate({ ...base, source: "manual", externalId: null })).toBeNull();
  });
});

describe("precheckAssetInput (what upsertAsset can reject without a database)", () => {
  const base = { buildingId: 1, category: "Lifts" as const, name: "Lift A" };

  it("asks nothing of an edit - it is a patch", () => {
    expect(precheckAssetInput({ assetId: 5 })).toBeNull();
    expect(precheckAssetInput({ assetId: 5, externalId: "MB-1", source: "mybuildings" })).toBeNull();
  });

  it("treats a request with no assetId and no externalId as a create", () => {
    expect(precheckAssetInput({ category: base.category, name: base.name })).toBe("buildingId is required");
    expect(precheckAssetInput({ buildingId: 1, category: base.category })).toBe("name is required");
    expect(precheckAssetInput({ buildingId: 1, name: base.name })).toBe("category is required");
    expect(precheckAssetInput({ ...base, source: "mybuildings" })).toBe("externalId is required when source is mybuildings");
    expect(precheckAssetInput(base)).toBeNull();
  });

  it("rejects an externalId on a manual asset whatever the database holds", () => {
    expect(precheckAssetInput({ ...base, externalId: "MB-1" })).toContain("only applies to imported assets");
    expect(precheckAssetInput({ ...base, externalId: "MB-1", source: "manual" })).toContain("only applies to imported assets");
  });

  it("leaves an imported asset to the lookup: it may be new or already known", () => {
    expect(precheckAssetInput({ externalId: "MB-1", name: "Renamed upstream", source: "mybuildings" })).toBeNull();
    expect(precheckAssetInput({ ...base, externalId: "MB-1", source: "mybuildings" })).toBeNull();
  });
});

describe("parseLocationInput / validateLocationCreate", () => {
  it("parses a space and a negative (manual) building id", () => {
    expect(
      valueOf(parseLocationInput({ buildingId: -3, kind: "space", name: " Plant room ", parentLocationId: 4, spaceType: "plant" })),
    ).toEqual({ buildingId: -3, kind: "space", name: "Plant room", parentLocationId: 4, spaceType: "plant" });
  });

  it.each([
    [{ kind: "floor" }, "kind must be one of"],
    [{ spaceType: "attic" }, "spaceType must be one of"],
    [{ name: "x".repeat(101) }, "name must be at most 100"],
    [{ sortOrder: 1.5 }, "sortOrder must be an integer"],
    [{ active: "yes" }, "active must be true or false"],
    [{ parentLocationId: 0 }, "parentLocationId must be an integer"],
  ])("rejects %j", (body, message) => {
    expect(errorOf(parseLocationInput(body as Record<string, unknown>))).toContain(message);
  });

  it("requires buildingId, kind and name to create", () => {
    expect(validateLocationCreate({ kind: "level", name: "G" })).toContain("buildingId");
    expect(validateLocationCreate({ buildingId: 1, name: "G" })).toContain("kind");
    expect(validateLocationCreate({ buildingId: 1, kind: "level" })).toContain("name");
    expect(validateLocationCreate({ buildingId: 1, kind: "level", name: "G" })).toBeNull();
  });

  it("keeps levels top-level and untyped", () => {
    expect(validateLocationCreate({ buildingId: 1, kind: "level", name: "G", parentLocationId: 2 })).toContain("cannot have a parent");
    expect(validateLocationCreate({ buildingId: 1, kind: "level", name: "G", spaceType: "plant" })).toContain("only applies to spaces");
    expect(validateLocationCreate({ buildingId: 1, kind: "space", name: "Roof", parentLocationId: null, spaceType: "roof" })).toBeNull();
  });
});

describe("parseAssetTypeInput", () => {
  it("normalises the category", () => {
    expect(valueOf(parseAssetTypeInput({ category: "lifts", name: "Passenger lift" }))).toEqual({
      category: "Lifts",
      name: "Passenger lift",
    });
  });

  it("rejects an unknown category and a blank name", () => {
    expect(errorOf(parseAssetTypeInput({ category: "Plumbing" }))).toContain("category must be one of");
    expect(errorOf(parseAssetTypeInput({ name: " " }))).toContain("name cannot be empty");
  });
});

describe("id bodies", () => {
  it("parseAssetIdInput requires a positive assetId", () => {
    expect(valueOf(parseAssetIdInput({ assetId: 5 }))).toEqual({ assetId: 5 });
    expect(errorOf(parseAssetIdInput({}))).toBe("assetId is required");
    expect(errorOf(parseAssetIdInput({ assetId: "5" }))).toContain("assetId must be an integer");
  });

  it("parseJobAssetInput requires both ids", () => {
    expect(valueOf(parseJobAssetInput({ assetId: 5, jobId: 9 }))).toEqual({ assetId: 5, jobId: 9 });
    expect(errorOf(parseJobAssetInput({ assetId: 5 }))).toBe("jobId is required");
    expect(errorOf(parseJobAssetInput({ jobId: 9 }))).toBe("assetId is required");
  });
});

describe("verification rule", () => {
  const current: AssetIdentity = {
    assetTypeId: 4,
    assetTypeNote: null,
    category: "HVAC / mechanical",
    locationId: 9,
    make: "Daikin",
    model: "EWAD",
    serialNumber: "SN1",
  };

  it.each([
    [{ locationId: 10 }],
    [{ locationId: null }],
    [{ category: "Electrical" as const }],
    [{ assetTypeId: 5 }],
    [{ assetTypeId: null }],
    [{ assetTypeNote: "Chilled water pump" }],
    [{ make: "Carrier" }],
    [{ model: "X" }],
    [{ serialNumber: "SN2" }],
  ])("%j changes the asset's identity", (patch) => {
    expect(identityChanged(current, patch)).toBe(true);
  });

  it.each([
    [{ name: "Renamed" }],
    [{ notes: "Serviced" }],
    [{ status: "out_of_service" as const }],
    [{ assetTag: "NEW-1" }],
    [{ parentAssetId: 3 }],
    [{ serviceContractorId: 8 }],
    [{ criticality: "critical" as const }],
    [{ specs: { kw: 1 } }],
    // re-sending what is already stored is not a change
    [{ locationId: 9, category: "HVAC / mechanical" as const, make: "Daikin", assetTypeId: 4 }],
    [{}],
  ])("%j leaves the identity alone", (patch) => {
    expect(identityChanged(current, patch)).toBe(false);
  });

  it("reads identity from a stored row", () => {
    expect(
      assetIdentityFromRow({
        AssetTypeId: 4,
        AssetTypeNote: null,
        Category: "HVAC / mechanical",
        LocationId: 9,
        Make: "Daikin",
        Model: "EWAD",
        SerialNumber: "SN1",
      }),
    ).toEqual(current);
  });

  it.each([
    [{ identityChanged: false, isVerified: false, requested: false }, "keep"],
    [{ identityChanged: false, isVerified: true, requested: false }, "keep"],
    [{ identityChanged: true, isVerified: false, requested: false }, "keep"],
    [{ identityChanged: true, isVerified: true, requested: false }, "clear"],
    [{ identityChanged: true, isVerified: true, requested: true }, "stamp"],
    [{ identityChanged: false, isVerified: false, requested: true }, "stamp"],
    [{ identityChanged: false, isVerified: true, requested: true }, "stamp"],
  ] as const)("%j -> %s", (args, expected) => {
    expect(resolveVerification(args)).toBe(expected);
  });
});

describe("query helpers", () => {
  it("parseQueryInt accepts integers (including negative building ids) and rejects the rest", () => {
    expect(valueOf(parseQueryInt(null, "id"))).toBeUndefined();
    expect(valueOf(parseQueryInt("", "id"))).toBeUndefined();
    expect(valueOf(parseQueryInt("42", "id"))).toBe(42);
    expect(valueOf(parseQueryInt("-3", "buildingId"))).toBe(-3);
    expect(errorOf(parseQueryInt("4x", "id"))).toBe("id must be an integer");
    expect(errorOf(parseQueryInt("1.5", "id"))).toBe("id must be an integer");
  });

  it("parseQueryBool accepts true/false in any case", () => {
    expect(valueOf(parseQueryBool(null, "v"))).toBeUndefined();
    expect(valueOf(parseQueryBool("TRUE", "v"))).toBe(true);
    expect(valueOf(parseQueryBool("false", "v"))).toBe(false);
    expect(errorOf(parseQueryBool("1", "verified"))).toBe("verified must be true or false");
  });
});

describe("uniqueViolationName", () => {
  it("extracts the index from a duplicate-key error", () => {
    const error = Object.assign(
      new Error("Cannot insert duplicate key row in object 'dbo.Assets' with unique index 'UX_Assets_Building_Tag'. The duplicate key value is (1, CH-01)."),
      { number: 2601 },
    );
    expect(uniqueViolationName(error)).toBe("UX_Assets_Building_Tag");
  });

  it("extracts the constraint from a unique-constraint error", () => {
    const error = Object.assign(new Error("Violation of PRIMARY KEY constraint 'PK_JobAssets'. Cannot insert duplicate key in object 'dbo.JobAssets'."), { number: 2627 });
    expect(uniqueViolationName(error)).toBe("PK_JobAssets");
  });

  it("recognises a duplicate by message alone, and returns '' when the name is missing", () => {
    expect(uniqueViolationName(new Error("Cannot insert duplicate key row"))).toBe("");
  });

  it("returns null for anything else", () => {
    expect(uniqueViolationName(new Error("Timeout"))).toBeNull();
    expect(uniqueViolationName(null)).toBeNull();
    expect(uniqueViolationName("boom")).toBeNull();
  });
});

describe("row -> API transforms", () => {
  const assetRow = {
    ArchivedAt: null,
    ArchivedBy: null,
    AssetId: 12,
    AssetTag: "CH-01",
    AssetTypeId: 4,
    AssetTypeName: "Chiller",
    AssetTypeNote: null,
    BuildingId: -1,
    Category: "HVAC / mechanical",
    CreatedAt: new Date("2026-10-13T01:02:03.000Z"),
    CreatedBy: "Connor R",
    Criticality: "critical",
    ExternalId: "MB-77",
    InstallDate: new Date("2024-02-29T00:00:00.000Z"),
    LocationId: 9,
    LocationName: "Plant room",
    Make: "Daikin",
    Model: null,
    Name: "Chiller 1",
    Notes: null,
    ParentAssetId: null,
    Responsibility: "owner",
    SerialNumber: null,
    ServiceContractorId: 12,
    ServiceContractorName: "Cool Co",
    Source: "mybuildings",
    Specs: '{"kw":410}',
    Status: "active",
    UpdatedAt: new Date("2026-10-14T00:00:00.000Z"),
    UpdatedBy: null,
    VerifiedAt: new Date("2026-10-15T00:00:00.000Z"),
    VerifiedBy: "Sam",
    WarrantyExpiry: null,
  };

  it("maps an asset row to camelCase with ISO dates", () => {
    const api = assetRowToApi(assetRow);
    expect(api).toMatchObject({
      assetId: 12,
      assetTag: "CH-01",
      assetTypeId: 4,
      assetTypeName: "Chiller",
      buildingId: -1,
      category: "HVAC / mechanical",
      createdAt: "2026-10-13T01:02:03.000Z",
      createdBy: "Connor R",
      externalId: "MB-77",
      installDate: "2024-02-29",
      isArchived: false,
      locationName: "Plant room",
      model: null,
      serviceContractorName: "Cool Co",
      source: "mybuildings",
      specs: { kw: 410 },
      verifiedAt: "2026-10-15T00:00:00.000Z",
      verifiedBy: "Sam",
      warrantyExpiry: null,
    });
  });

  it("leaves specs out when the list query did not select the column", () => {
    const { Specs: _specs, ...listRow } = assetRow;
    expect("specs" in assetRowToApi(listRow)).toBe(false);
  });

  it("treats unreadable specs as none and reports archived rows", () => {
    expect(assetRowToApi({ ...assetRow, Specs: "{oops" }).specs).toBeNull();
    expect(assetRowToApi({ ...assetRow, Specs: "[1]" }).specs).toBeNull();
    expect(assetRowToApi({ ...assetRow, Specs: null }).specs).toBeNull();
    const archived = assetRowToApi({ ...assetRow, ArchivedAt: new Date("2026-10-20T00:00:00.000Z"), ArchivedBy: "Sam" });
    expect(archived).toMatchObject({ archivedAt: "2026-10-20T00:00:00.000Z", archivedBy: "Sam", isArchived: true });
  });

  it("maps locations, types, linked jobs", () => {
    expect(
      locationRowToApi({ Active: true, BuildingId: 1, Kind: "space", LocationId: 3, Name: "Suite 1", ParentLocationId: 2, SortOrder: 0, SpaceType: "tenancy" }),
    ).toEqual({ active: true, buildingId: 1, kind: "space", locationId: 3, name: "Suite 1", parentLocationId: 2, sortOrder: 0, spaceType: "tenancy" });
    expect(assetTypeRowToApi({ Active: 1, AssetTypeId: 4, Category: "Lifts", Name: "Passenger lift", SortOrder: 2 })).toEqual({
      active: true,
      assetTypeId: 4,
      category: "Lifts",
      name: "Passenger lift",
      sortOrder: 2,
    });
    expect(
      linkedJobRowToApi({ IsArchived: false, JobID: 7, Kind: "maintenance", LinkedAt: new Date("2026-10-13T00:00:00.000Z"), LinkedBy: "Connor R", Status: "Work", Title: "Annual service" }),
    ).toEqual({ isArchived: false, jobId: 7, kind: "maintenance", linkedAt: "2026-10-13T00:00:00.000Z", linkedBy: "Connor R", status: "Work", title: "Annual service" });
  });

  it("builds a location path root-first with a label", () => {
    const api = locationChainToApi([
      { Active: true, Kind: "level", LocationId: 1, Name: "Level 3", SpaceType: null },
      { Active: true, Kind: "space", LocationId: 2, Name: "Plant room", SpaceType: "plant" },
    ]);
    expect(api).toMatchObject({ kind: "space", locationId: 2, name: "Plant room", pathLabel: "Level 3 / Plant room", spaceType: "plant" });
    expect(api?.path.map((p) => p.locationId)).toEqual([1, 2]);
    expect(locationChainToApi([])).toBeNull();
  });

  it("maps attachments, turning BIGINT strings into numbers", () => {
    const api = attachmentRowToApi(
      { AssetId: 12, AttachedAt: new Date("2026-10-13T00:00:00.000Z"), Comment: null, ContentType: "application/pdf", Extension: "pdf", Id: 5, OriginalName: "manual.pdf", SizeBytes: "20480", UploadedAt: new Date("2026-10-13T00:00:00.000Z"), UploadedBy: "oid-1", UploadedByName: "Connor R" },
      "https://sas/x",
    );
    expect(api).toMatchObject({ id: 5, sasUrl: "https://sas/x", sizeBytes: 20480, uploadedBy: "oid-1", uploadedByName: "Connor R" });
    expect(attachmentRowToApi({ Id: 6, OriginalName: "a.png", SizeBytes: null }, null).sizeBytes).toBeNull();
  });
});
