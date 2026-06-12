import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Regression guard: handlers must not use `SELECT *`. Use a file-scoped
// column constant (see JOB_COLUMNS in jobs.ts) so column additions don't
// silently leak into API responses and renames fail loudly at query time.
const FILES_THAT_MUST_NOT_USE_SELECT_STAR = [
  "src/functions/timesheets.ts",
  "src/functions/attachments.ts",
  "src/functions/getBuildings.ts",
];

describe("no SELECT * in handlers", () => {
  for (const relPath of FILES_THAT_MUST_NOT_USE_SELECT_STAR) {
    test(`${relPath} contains no \`SELECT *\``, () => {
      const abs = join(__dirname, "..", "..", relPath);
      const source = readFileSync(abs, "utf8");
      // Match SELECT followed by whitespace then *, case-insensitive.
      // Excludes COUNT(*) deliberately — only the bare projection is banned.
      const offenders = source.match(/SELECT\s+\*/gi) ?? [];
      assert.strictEqual(
        offenders.length,
        0,
        `Found ${offenders.length} occurrence(s) of SELECT * in ${relPath}`,
      );
    });
  }
});
