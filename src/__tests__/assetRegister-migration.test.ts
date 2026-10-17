/// <reference types="jest" />
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ASSET_BLOB_PREFIX,
  ASSET_CRITICALITIES,
  ASSET_RESPONSIBILITIES,
  ASSET_SOURCES,
  ASSET_STATUSES,
  LOCATION_KINDS,
  SPACE_TYPES,
  UNIQUE_INDEXES,
} from "../assetRegister";
import { ASSET_DETAIL_COLUMNS, ASSET_TYPE_COLUMNS, LOCATION_COLUMNS } from "../assetRegisterSupport";

// Migration 113 is applied by the startup runner, which refuses to boot the app
// if a batch throws, and there is no SQL Server in the unit tests. These checks
// pin what can be pinned without one: the file stays additive and re-runnable,
// the seeds keep their dirty-data guards, and the schema stays in step with the
// enums, column lists and index names the handlers rely on.

const ROOT = join(__dirname, "..", "..");
const sql = readFileSync(join(ROOT, "migrations", "113_locations_and_assets.sql"), "utf8");
const code = sql
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

function tableBlock(table: string): string {
  const start = code.indexOf(`CREATE TABLE dbo.${table} (`);
  if (start < 0) throw new Error(`CREATE TABLE dbo.${table} not found`);
  return code.slice(start, code.indexOf("\n    );", start));
}

function checkValues(constraint: string): string[] {
  const at = code.indexOf(`CONSTRAINT ${constraint} CHECK`);
  if (at < 0) throw new Error(`${constraint} not found`);
  const list = code.slice(at).match(/\bIN \(([^)]*)\)/);
  if (!list) throw new Error(`${constraint} has no IN list`);
  return list[1].split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
}

function columnsOf(table: string): Set<string> {
  const names = tableBlock(table)
    .split("\n")
    .map((line) => line.match(/^ {8}(\w+)\s+(?:INT|NVARCHAR|DATE|DATETIME2|BIT)\b/)?.[1])
    .filter((name): name is string => Boolean(name));
  return new Set(names);
}

function aliasedColumns(fragment: string, alias: string): string[] {
  return [...fragment.matchAll(new RegExp(`\\b${alias}\\.(\\w+)`, "g"))].map((m) => m[1]);
}

function sourceOf(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

/** Every non-test source file under src/, as [relative path, text]. */
function productionSources(dir = join(ROOT, "src")): Array<[string, string]> {
  return readdirSync(dir).flatMap((name): Array<[string, string]> => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : productionSources(full);
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) return [];
    return [[full.slice(ROOT.length + 1), readFileSync(full, "utf8")]];
  });
}

describe("migration 113: shape of the file", () => {
  it("splits on GO into batches the runner can execute one by one", () => {
    const batches = sql.split(/^GO\s*$/im).map((b) => b.trim()).filter(Boolean);
    expect(batches.length).toBeGreaterThan(20);
    for (const batch of batches) expect(batch).not.toMatch(/^GO$/im);
  });

  it.each(["Locations", "AssetTypes", "Assets", "JobAssets", "AssetAttachments"])(
    "creates dbo.%s exactly once, behind an OBJECT_ID guard",
    (table) => {
      expect(code.match(new RegExp(`CREATE TABLE dbo\\.${table} \\(`, "g"))).toHaveLength(1);
      expect(code).toContain(`IF OBJECT_ID('dbo.${table}', 'U') IS NULL`);
    },
  );

  it("guards every index with a sys.indexes check on its own name", () => {
    const indexes = [...code.matchAll(/CREATE (?:UNIQUE )?INDEX (\w+)/g)].map((m) => m[1]);
    expect(indexes.length).toBeGreaterThanOrEqual(10);
    // Concatenated, not templated: the repo's SQL-interpolation lint rule would read this as SQL.
    for (const name of indexes) expect(code).toContain("WHERE name = '" + name + "'");
  });

  it("is strictly additive (no drops, deletes, updates, alters)", () => {
    expect(code).not.toMatch(/\bDROP\b/i);
    expect(code).not.toMatch(/\bTRUNCATE\b/i);
    expect(code).not.toMatch(/\bALTER\b/i);
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(code).not.toMatch(/\bUPDATE\b/i);
  });

  it("numbers itself 113", () => {
    expect(sql).toMatch(/Migration 113:/);
  });
});

describe("migration 113: seeds are re-runnable MERGEs that cannot abort startup", () => {
  it("seeds Locations only through three insert-only MERGEs", () => {
    expect(code.match(/MERGE dbo\.Locations AS target/g)).toHaveLength(3);
    expect(code.match(/WHEN NOT MATCHED BY TARGET THEN/g)).toHaveLength(3);
    expect(code).not.toMatch(/WHEN MATCHED/i);
    expect(code).not.toMatch(/INSERT INTO dbo\.Locations/i);
  });

  it("does not seed asset types (managers build the taxonomy from the myBuildings mapping)", () => {
    expect(code).not.toMatch(/INSERT[^;]*dbo\.AssetTypes/i);
    expect(code).not.toMatch(/MERGE dbo\.AssetTypes/i);
  });

  it("only feeds OPENJSON valid JSON arrays, and never reads its BIN2 text uncollated", () => {
    expect(code).toContain("ISJSON(b.Levels) = 1");
    expect(code).toContain("LEFT(LTRIM(b.Levels), 1) = N'['");
    expect(code).not.toMatch(/OPENJSON\(\s*b\.Levels/);
    expect(code).toContain("COLLATE DATABASE_DEFAULT");
  });

  it("trims names, caps them at the column width and de-duplicates before inserting", () => {
    expect(code.match(/CAST\(LEFT\(LTRIM\(RTRIM\(/g)!.length).toBeGreaterThanOrEqual(4);
    expect(code).toMatch(/GROUP BY BuildingId, Name/);
    expect(code.match(/SELECT DISTINCT/g)).toHaveLength(2);
  });

  it("ignores occupancies for buildings that no longer exist (they would break the FK)", () => {
    expect(code.match(/JOIN dbo\.Buildings b ON b\.BuildingID = o\.BuildingId/g)).toHaveLength(2);
  });

  it("matches existing rows by name regardless of Active, so a manual re-run adds nothing", () => {
    expect(code.match(/AND target\.Name = source\.Name/g)).toHaveLength(3);
    expect(code).toContain("AND target.ParentLocationId IS NULL");
    expect(code).toContain("AND target.ParentLocationId = source.ParentLocationId");
  });

  it("parents tenancy spaces to active levels only", () => {
    expect(code).toMatch(/lvl\.Kind = 'level'\s+AND lvl\.Active = 1/);
  });
});

describe("migration 113: schema stays in step with the handlers", () => {
  it.each([
    ["CK_Assets_Status", ASSET_STATUSES],
    ["CK_Assets_Responsibility", ASSET_RESPONSIBILITIES],
    ["CK_Assets_Criticality", ASSET_CRITICALITIES],
    ["CK_Assets_Source", ASSET_SOURCES],
    ["CK_Locations_Kind", LOCATION_KINDS],
    ["CK_Locations_SpaceType", SPACE_TYPES],
  ] as const)("%s allows exactly the values the API accepts", (constraint, values) => {
    expect(checkValues(constraint)).toEqual([...values]);
  });

  it("selects only columns that exist", () => {
    const assets = columnsOf("Assets");
    for (const column of aliasedColumns(ASSET_DETAIL_COLUMNS, "a")) expect(assets).toContain(column);
    const locations = columnsOf("Locations");
    for (const column of aliasedColumns(LOCATION_COLUMNS, "l")) expect(locations).toContain(column);
    const types = columnsOf("AssetTypes");
    for (const column of aliasedColumns(ASSET_TYPE_COLUMNS, "t")) expect(types).toContain(column);
  });

  it.each([
    ["src/functions/upsertAsset.ts", "Assets", /INSERT INTO dbo\.Assets\s*\(([^)]*)\)/, "ASSET_UPDATE_COLUMNS"],
    ["src/functions/upsertLocation.ts", "Locations", /INSERT INTO dbo\.Locations\s*\(([^)]*)\)/, "LOCATION_UPDATE_COLUMNS"],
    ["src/functions/upsertAssetType.ts", "AssetTypes", /INSERT INTO dbo\.AssetTypes\s*\(([^)]*)\)/, "ASSET_TYPE_UPDATE_COLUMNS"],
  ])("%s writes only columns that exist in dbo.%s", (file, table, insertPattern, updateConst) => {
    const source = sourceOf(file);
    const known = columnsOf(table);
    const inserted = source.match(insertPattern)?.[1].split(",").map((c) => c.trim()) ?? [];
    expect(inserted.length).toBeGreaterThan(3);
    for (const column of inserted) expect(known).toContain(column);

    const updatable = source.match(new RegExp(`const ${updateConst} = \\{([\\s\\S]*?)\\};`))?.[1] ?? "";
    const updateColumns = [...updatable.matchAll(/(\w+):/g)].map((m) => m[1]);
    expect(updateColumns.length).toBeGreaterThan(3);
    for (const column of updateColumns) expect(known).toContain(column);
  });

  it("replaces free-text AssetType with a controlled type plus a note", () => {
    const assets = columnsOf("Assets");
    expect(assets).toContain("AssetTypeId");
    expect(assets).toContain("AssetTypeNote");
    expect(assets).not.toContain("AssetType");
    expect(code).toMatch(/CONSTRAINT FK_Assets_AssetTypes FOREIGN KEY \(AssetTypeId\)\s+REFERENCES dbo\.AssetTypes\(AssetTypeId\)/);
  });

  it("carries provenance and verification columns", () => {
    const assets = columnsOf("Assets");
    for (const column of ["Source", "ExternalId", "VerifiedAt", "VerifiedBy"]) expect(assets).toContain(column);
    expect(code).toMatch(/Source\s+NVARCHAR\(20\)\s+NOT NULL CONSTRAINT DF_Assets_Source DEFAULT 'manual'/);
  });

  it("defines every unique index the handlers translate into a 409", () => {
    for (const name of Object.values(UNIQUE_INDEXES)) expect(code).toContain(`CREATE UNIQUE INDEX ${name}`);
  });

  it("keeps unlinked job-asset rows: soft-delete columns, a surrogate key, uniqueness among live links only", () => {
    const columns = columnsOf("JobAssets");
    for (const column of ["LinkId", "JobId", "AssetId", "LinkedAt", "LinkedBy", "UnlinkedAt", "UnlinkedBy"]) {
      expect(columns).toContain(column);
    }
    const table = tableBlock("JobAssets");
    expect(table).toMatch(/UnlinkedAt\s+DATETIME2\s+NULL/);
    expect(table).toMatch(/UnlinkedBy\s+NVARCHAR\(200\)\s+NULL/);
    // A (JobId, AssetId) primary key would forbid linking a pair a second time.
    expect(table).toMatch(/CONSTRAINT PK_JobAssets PRIMARY KEY \(LinkId\)/);
    expect(code).toMatch(/CREATE UNIQUE INDEX UX_JobAssets_Live\s+ON dbo\.JobAssets \(JobId, AssetId\)\s+WHERE UnlinkedAt IS NULL;/);
  });

  it("filters every statement on dbo.JobAssets to live links, and names only columns that exist", () => {
    const known = columnsOf("JobAssets");
    const statements = productionSources().flatMap(([file, text]) =>
      [...text.matchAll(/`([^`]*dbo\.JobAssets[^`]*)`/g)].map((match): [string, string] => [file, match[1]]),
    );
    // getAsset's read, linkJobAsset's insert and existing-link read, unlinkJobAsset's update.
    expect(statements.length).toBeGreaterThanOrEqual(4);
    for (const [file, statement] of statements) {
      expect([file, statement]).toEqual([file, expect.stringContaining("UnlinkedAt IS NULL")]);
      for (const token of statement.match(/\b(?:Un)?[Ll]inked\w*/g) ?? []) expect(known).toContain(token);
    }
  });

  it("frees an archived asset's tag but keeps archived imports findable", () => {
    expect(code).toMatch(/UX_Assets_Building_Tag\s+ON dbo\.Assets \(BuildingId, AssetTag\)\s+WHERE AssetTag IS NOT NULL AND ArchivedAt IS NULL;/);
    expect(code).toMatch(/UX_Assets_Source_External\s+ON dbo\.Assets \(Source, ExternalId\)\s+WHERE ExternalId IS NOT NULL;/);
  });

  it("keeps levels top-level and untyped at the database too", () => {
    expect(code).toMatch(/CK_Locations_LevelShape CHECK \(\s*Kind <> 'level' OR \(ParentLocationId IS NULL AND SpaceType IS NULL\)/);
  });

  it("references Buildings by its business key BuildingID, like every other table", () => {
    expect(code.match(/REFERENCES dbo\.Buildings\(BuildingID\)/g)).toHaveLength(2);
  });
});

describe("asset files are never reaped", () => {
  it("has no attachment cleanup timer, and an asset upload is never a work-request row", () => {
    expect(ASSET_BLOB_PREFIX).toBe("asset-");
    expect(existsSync(join(__dirname, "..", "functions", "cleanupAttachments.ts"))).toBe(false);
    const columns = sourceOf("src/functions/uploadAssetAttachment.ts").match(/INSERT INTO dbo\.Attachments\s*\(([^)]*)\)/)?.[1] ?? "";
    expect(columns).toContain("BlobName");
    expect(columns).not.toMatch(/WorkRequestID|JobID/);
  });
});
