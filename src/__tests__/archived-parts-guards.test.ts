import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { aliasOf, filtersArchived, PART_READ, statementAt } from "./fixtures/archivedPartReads";

// D10 guard: archived areas and car parks leave the register, the summary,
// the portfolio figures and the planner; archived notes (D11) leave the
// tenancy's notes and the register's note counts. Every read of
// dbo.TenantOccupancies, dbo.Carparks or dbo.TenantNotes must carry a positive `ArchivedAt IS NULL` predicate on that
// table's own alias (unqualified when it has none), except the reviewed reads
// below that must see archived rows on purpose.

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src");

// file → number of reads that may see archived rows, and why.
const SEES_ARCHIVED: Record<string, { count: number; why: string }> = {
  "src/functions/tenancy.ts": {
    count: 7,
    why: "upsertOccupancy's cell check and upsertCarpark's identifier check (to refuse an archived cell or bay), the stored row read back by id after each upsert, the two 'with archived' lists behind includeArchived, and createTenantNote's read-back of the note it just wrote",
  },
  "src/tenant-notes.ts": { count: 2, why: "archive / restore read the note by id under lock, whatever its state, and the Archived view reads archived notes on purpose" },
  "src/tenancy-parts-archive.ts": { count: 2, why: "archive / restore read the row by id under lock, whatever its state" },
  "src/tenancy-records.ts": { count: 3, why: "the empty-draft check: an archived area, bay or note still holds the tenancy's history" },
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : sourceFiles(full);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });
}

const filtered = (text: string, match: RegExpMatchArray): boolean => filtersArchived(statementAt(text, match.index ?? 0), aliasOf(match));

describe("archived areas and car parks stay out of reads (D10)", () => {
  const files = sourceFiles(SRC).map((full) => ({ file: relative(ROOT, full).split("\\").join("/"), text: readFileSync(full, "utf8") }));
  const unfiltered = files.flatMap(({ file, text }) =>
    [...text.matchAll(PART_READ)].filter((match) => !filtered(text, match)).map(() => file),
  );

  it("filters every read except the reviewed ones", () => {
    const counts = unfiltered.reduce<Record<string, number>>((acc, file) => ({ ...acc, [file]: (acc[file] ?? 0) + 1 }), {});
    expect(counts).toEqual(Object.fromEntries(Object.entries(SEES_ARCHIVED).map(([file, { count }]) => [file, count])));
  });

  it.each([
    ["src/functions/plannerSyncTimer.ts", "the planner's first area"],
    ["src/functions/tenants.ts", "the legacy tenant list's levels"],
    ["src/functions/vacancies.ts", "vacant tenancies' areas"],
    ["src/rentReview/store.ts", "a review's floor area"],
  ])("%s reads only live areas (%s)", (file) => {
    const text = files.find((f) => f.file === file)?.text ?? "";
    const reads = [...text.matchAll(PART_READ)];
    expect(reads.length).toBeGreaterThan(0);
    for (const match of reads) expect([file, filtered(text, match)]).toEqual([file, true]);
  });

  // The review's surviving mutant: the portfolio figures' occupancy subquery with
  // its own filter removed still has D4's `t.ArchivedAt IS NULL` on the tenancy.
  it.each([
    ["the portfolio subquery, unaliased", "FROM dbo.Tenants t INNER JOIN (SELECT TenantId, SUM(SizeSqm) AS TenantSqm FROM dbo.TenantOccupancies GROUP BY TenantId) occ ON occ.TenantId = t.TenantId WHERE t.ArchivedAt IS NULL", false],
    ["an aliased join filtered on another alias", "FROM dbo.Tenants t JOIN dbo.TenantOccupancies o ON o.TenantId = t.TenantId WHERE t.ArchivedAt IS NULL", false],
    ["an aliased bay read filtered on its own alias", "FROM dbo.Carparks c WHERE c.TenantId = @Id AND c.ArchivedAt IS NULL", true],
    ["an aliased read filtered unqualified", "FROM dbo.TenantOccupancies o WHERE ArchivedAt IS NULL", false],
    ["the portfolio subquery as written", "INNER JOIN (SELECT TenantId FROM dbo.TenantOccupancies WHERE ArchivedAt IS NULL GROUP BY TenantId) occ ON occ.TenantId = t.TenantId WHERE t.ArchivedAt IS NULL", true],
  ])("tells %s apart", (_name, sql, expected) => {
    const reads = [...sql.matchAll(PART_READ)];
    expect(reads).toHaveLength(1);
    expect(filtered(sql, reads[0])).toBe(expected);
  });

  it("no source hard-deletes an area or a bay", () => {
    for (const { file, text } of files) {
      expect([file, /DELETE\s+(?:FROM\s+)?(?:dbo\.)?(?:TenantOccupancies|Carparks)\b/i.test(text)]).toEqual([file, false]);
    }
  });
});
