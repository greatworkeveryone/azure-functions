import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// D10 guard: archived areas and car parks leave the register, the summary,
// the portfolio figures and the planner. Every read of dbo.TenantOccupancies
// or dbo.Carparks must carry a positive `ArchivedAt IS NULL` predicate, except
// the reviewed reads below that must see archived rows on purpose.

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src");
const READ = /\b(?:FROM|JOIN)\s+dbo\.(TenantOccupancies|Carparks)\b/g;

// file → number of reads that may see archived rows, and why.
const SEES_ARCHIVED: Record<string, { count: number; why: string }> = {
  "src/functions/tenancy.ts": {
    count: 6,
    why: "upsertOccupancy's cell check and upsertCarpark's identifier check (to refuse an archived cell or bay), the stored row read back by id after each upsert, and the two 'with archived' lists behind includeArchived",
  },
  "src/tenancy-parts-archive.ts": { count: 2, why: "archive / restore read the row by id under lock, whatever its state" },
  "src/tenancy-records.ts": { count: 2, why: "the empty-draft check: an archived area or bay still holds the tenancy's history" },
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : sourceFiles(full);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });
}

function statementAt(text: string, index: number): string {
  const end = text.indexOf("`", index);
  return text.slice(index, end === -1 ? undefined : end);
}

describe("archived areas and car parks stay out of reads (D10)", () => {
  const files = sourceFiles(SRC).map((full) => ({ file: relative(ROOT, full).split("\\").join("/"), text: readFileSync(full, "utf8") }));
  const unfiltered = files.flatMap(({ file, text }) =>
    [...text.matchAll(READ)]
      .filter((match) => !/ArchivedAt IS NULL/.test(statementAt(text, match.index ?? 0)))
      .map(() => file),
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
    const reads = [...text.matchAll(READ)];
    expect(reads.length).toBeGreaterThan(0);
    for (const match of reads) expect(statementAt(text, match.index ?? 0)).toMatch(/ArchivedAt IS NULL/);
  });

  it("no source hard-deletes an area or a bay", () => {
    for (const { file, text } of files) {
      expect([file, /DELETE\s+(?:FROM\s+)?(?:dbo\.)?(?:TenantOccupancies|Carparks)\b/i.test(text)]).toEqual([file, false]);
    }
  });
});
