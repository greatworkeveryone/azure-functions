import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { findDestructiveStatements } from "../migrate-files";

// Guards for the database-safety rules (~/.claude/rules/database-safety.md):
// a destructive migration needs a written approval header, and every place
// that hard-deletes rows or blobs is on a reviewed allowlist. A failure here
// is a stop sign — review the change, then update the allowlist deliberately.

const ROOT = join(__dirname, "..", "..");
const MIGRATIONS_DIR = join(ROOT, "migrations");
const SRC_DIR = join(ROOT, "src");

// Migrations before this number predate the rules and are grandfathered.
const FIRST_GUARDED_MIGRATION = 94;

const DESTRUCTIVE = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bALTER\s+COLUMN\b/i,
  /\bsp_rename\b/i,
];
const APPROVAL_HEADER = /^--\s*DESTRUCTIVE:.+approved by .+\d{4}-\d{2}-\d{2}/im;

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");
}

// The regexes above, plus the runner's own scan (src/migrate-files.ts), which
// also catches a DELETE without FROM ("DELETE dbo.Jobs WHERE …"), the alias
// form, dynamic SQL, and an UPDATE that rewrites values already there rather
// than backfilling a column that is still NULL.
function destructiveHits(sql: string): string[] {
  const own = DESTRUCTIVE.filter((re) => re.test(stripSqlComments(sql))).map(String);
  return [...own, ...findDestructiveStatements(sql)];
}

describe("migrations are additive unless explicitly approved", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter(
    (f) => f.endsWith(".sql") && Number.parseInt(f, 10) >= FIRST_GUARDED_MIGRATION,
  );

  it.each(files.length ? files : ["(none yet)"])("%s", (file) => {
    if (file === "(none yet)") return;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    if (destructiveHits(sql).length > 0) {
      expect(sql).toMatch(APPROVAL_HEADER);
    }
  });
});

describe("the migration scan, on crafted text", () => {
  it.each([
    ["a DELETE without FROM", "DELETE dbo.Jobs WHERE JobID = 1;"],
    ["an alias DELETE", "DELETE r FROM dbo.InspectionRooms r WHERE r.RoomId = 1;"],
    ["an UPDATE that rewrites values", "UPDATE dbo.Jobs SET Status = 'Done' WHERE JobID = 1;"],
    ["an UPDATE with no WHERE", "UPDATE dbo.Tenants SET RentPerAnnum = 0;"],
    ["an UPDATE that backfills one column and rewrites another", "UPDATE dbo.Buildings SET Levels = 'G', Name = 'x' WHERE Levels IS NULL;"],
  ])("flags %s", (_label, sql) => {
    expect(destructiveHits(sql)).not.toEqual([]);
  });

  it.each([
    ["a backfill of a column still NULL", "UPDATE dbo.Buildings SET ReferenceCode = N'HB' WHERE ReferenceCode IS NULL;"],
    ["an aliased backfill through a join", "UPDATE b\n   SET b.ReferenceCode = h.RefCode\n  FROM dbo.Buildings b\n  JOIN @hits h ON h.BuildingID = b.BuildingID\n WHERE b.ReferenceCode IS NULL"],
    ["a trigger's event list", "EXEC(N'CREATE TRIGGER t ON dbo.A INSTEAD OF UPDATE, DELETE AS BEGIN THROW 51000, ''no'', 1; END;');"],
    ["an FK action", "ALTER TABLE dbo.A ADD CONSTRAINT FK_A FOREIGN KEY (B) REFERENCES dbo.B(Id) ON DELETE CASCADE;"],
  ])("leaves %s alone", (_label, sql) => {
    expect(destructiveHits(sql)).toEqual([]);
  });
});

// Hard-delete call sites as reviewed on 13 Oct 2026. Existing entries are
// grandfathered pending the money-controls review (LAUNCH-READINESS WP42);
// a new file or a higher count fails until someone reviews it and edits this.
const DELETE_ALLOWLIST: Record<string, { deleteBlob?: number; deleteFrom?: number; deleteOther?: number }> = {
  "src/blob-storage.ts": { deleteBlob: 1 },
  "src/functions/attachments.ts": { deleteBlob: 1, deleteFrom: 2 },
  // deleteOther: the four alias-form deletes (removeRoom, removePoint,
  // removeAttachment, the linkRooms fold), invisible to the FROM-only count
  // until D5. Grandfathered for the inspection archive package (D6), not reviewed safe.
  // No deleteBlob: point, room, level and photo removal all write their ledger row first
  // and leave the files in storage (UX fix round 2, B2).
  "src/functions/inspections.ts": { deleteFrom: 6, deleteOther: 4 },
  // Removes only the blob this same request just uploaded (fresh randomUUID key) when the register insert did not commit,
  // and only after a fresh read finds no RegisterDocuments row referencing it.
  "src/functions/document-register.ts": { deleteBlob: 1 },
  "src/functions/invoices.ts": { deleteFrom: 1 },
  "src/functions/jobRequestedContractors.ts": { deleteFrom: 1 },
  // Removes only the blob this same request just uploaded (fresh randomUUID key under major-events/<id>/) when the document insert
  // did not commit, and only after a fresh read finds no MajorEventDocuments row referencing it.
  "src/functions/major-events.ts": { deleteBlob: 1 },
  "src/functions/purchaseOrders.ts": { deleteBlob: 1, deleteFrom: 1 },
  "src/functions/quotes.ts": { deleteFrom: 1 },
  // src/functions/tenancy.ts deletes nothing: areas and car parks are archived
  // (D10, tenancy-parts-archive.ts), notes too (D11, tenant-notes.ts), and the
  // tenancy delete moved to src/tenancy-records.ts and is reviewed below.
  // Removes only the blob this same request just uploaded, when the database insert that follows it fails.
  "src/functions/uploadAssetAttachment.ts": { deleteBlob: 1 },
  "src/functions/vacancies.ts": { deleteFrom: 1 },
  // REVIEWED (UA1, 24 Oct 2026): the usage purge. Two deletes, both opt-in (USAGE_PURGE_ENABLED), selected positively and in
  // batches: raw UsageViews past retention whose person-day is rolled up after the day ended and after the session's last
  // heartbeat, then UsageSessions past retention with no views left whose day is rolled up. Daily roll-ups and devices are
  // never deleted. See src/usage/purge.ts and usagePurgeTimer.ts.
  "src/usage/purge.ts": { deleteFrom: 2 },
  "src/functions/workRequests.ts": { deleteFrom: 1 },
  // REVIEWED (D4, 17 Oct 2026): the one tenancy hard delete, shared by
  // deleteRegisterTenant and deleteTenant. See TENANCY_DRAFT_DELETE below.
  "src/tenancy-records.ts": { deleteFrom: 1 },
};

// The reviewed tenancy hard delete and the conditions it was reviewed under:
// it runs inside a transaction, after the tenancy and every table that refers
// to it were read under lock and found empty — no jobs, keys, vacancies,
// occupancies or their history, notes, rent reviews, rent schedule change log,
// lease documents, car parks, decision-ledger rows (as subject or scope),
// schedule sign-off, defects periods, schedule change requests or documentation
// register entries — and every column a person can fill in on the tenancy is
// empty (src/tenancyDraftContent.ts; D11 re-check S1-2), and its own ledger row
// (tenancy.delete_draft), holding the whole deleted row, is written before the commit.
const TENANCY_DRAFT_DELETE = {
  file: "src/tenancy-records.ts",
  fn: "deleteTenancyDraft",
  statement: /DELETE\s+FROM\s+(?:dbo\.)?Tenants\b/gi,
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : sourceFiles(full);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });
}

function count(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

// A DELETE not followed by FROM: "DELETE dbo.T WHERE …" and the alias form
// "DELETE r FROM dbo.T r …" (data-loss audit §6.2). Not ON DELETE (an FK
// action) or a trigger's event list (", DELETE AS").
const DELETE_OTHER = /(?<!(?:\bON|\bOF|\bFOR|\bAFTER|,)\s*)\bDELETE\s+(?!FROM\b)(?:TOP\s*\(\s*\d+\s*\)\s*)?[\w.@#[\]]+\s+(?:WHERE|OUTPUT|FROM)\b/gi;

function hardDeletes(text: string) {
  return {
    deleteBlob: count(text, /deleteBlob\(/g),
    deleteFrom: count(text, /DELETE\s+FROM/gi),
    deleteOther: count(text, DELETE_OTHER),
  };
}

describe("hard deletes only happen at reviewed call sites", () => {
  const found = sourceFiles(SRC_DIR)
    .map((full) => ({
      ...hardDeletes(readFileSync(full, "utf8")),
      file: relative(ROOT, full).split("\\").join("/"),
    }))
    .filter((f) => f.deleteBlob > 0 || f.deleteFrom > 0 || f.deleteOther > 0);

  it.each(found)("$file", ({ deleteBlob, deleteFrom, deleteOther, file }) => {
    const allowed = DELETE_ALLOWLIST[file] ?? {};
    expect(deleteBlob).toBeLessThanOrEqual(allowed.deleteBlob ?? 0);
    expect(deleteFrom).toBeLessThanOrEqual(allowed.deleteFrom ?? 0);
    expect(deleteOther).toBeLessThanOrEqual(allowed.deleteOther ?? 0);
  });
});

describe("the source scan, on crafted text", () => {
  it("counts a DELETE without FROM and the alias form, not an FK action or a trigger's events", () => {
    expect(hardDeletes("`DELETE dbo.Jobs WHERE JobID = @Id`").deleteOther).toBe(1);
    expect(hardDeletes("`DELETE r\n   FROM InspectionRooms r WHERE r.Id = @Id`").deleteOther).toBe(1);
    expect(hardDeletes("`DELETE FROM Jobs WHERE JobID = @Id`")).toEqual({ deleteBlob: 0, deleteFrom: 1, deleteOther: 0 });
    expect(hardDeletes("ON DELETE CASCADE; INSTEAD OF UPDATE, DELETE AS BEGIN").deleteOther).toBe(0);
  });
});

describe("the tenancy hard delete is the reviewed one", () => {
  const files = sourceFiles(SRC_DIR).map((full) => ({
    file: relative(ROOT, full).split("\\").join("/"),
    text: readFileSync(full, "utf8"),
  }));

  it("exists once, in deleteTenancyDraft, and nowhere else", () => {
    const hits = files.flatMap(({ file, text }) => Array(count(text, TENANCY_DRAFT_DELETE.statement)).fill(file));
    expect(hits).toEqual([TENANCY_DRAFT_DELETE.file]);
  });

  it("runs only after the empty-draft refusal, inside the transaction, and is ledgered before the commit", () => {
    const text = files.find((f) => f.file === TENANCY_DRAFT_DELETE.file)?.text ?? "";
    const start = text.indexOf(`export async function ${TENANCY_DRAFT_DELETE.fn}(`);
    expect(start).toBeGreaterThan(-1);
    const body = text.slice(start, text.indexOf("\n}\n", start));
    const at = (needle: string) => body.indexOf(needle);
    const deleteAt = body.search(/DELETE_DRAFT_SQL/);
    expect(at("beginTransaction(")).toBeGreaterThan(-1);
    expect(at("readDraftFacts(")).toBeGreaterThan(at("beginTransaction("));
    expect(at("draftDeletionRefusal(")).toBeGreaterThan(at("readDraftFacts("));
    expect(deleteAt).toBeGreaterThan(at("draftDeletionRefusal("));
    expect(at('"tenancy.delete_draft"')).toBeGreaterThan(deleteAt);
    expect(at("commitTransaction(")).toBeGreaterThan(at('"tenancy.delete_draft"'));
  });

  it("is reached from both delete routes and from nowhere else", () => {
    const callers = files
      .filter(({ file, text }) => file !== TENANCY_DRAFT_DELETE.file && text.includes(`${TENANCY_DRAFT_DELETE.fn}(`))
      .map((f) => f.file)
      .sort();
    expect(callers).toEqual(["src/functions/tenancy.ts", "src/functions/tenants.ts"]);
  });
});
