import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Regression guard: certain query patterns prevent the SQL planner from
// using indexes (non-sargable). Each entry below bans a specific pattern
// in a specific file. Add new entries as new offenders are identified.
const BANS: { file: string; pattern: RegExp; reason: string }[] = [
  {
    file: "src/functions/plannerSyncTimer.ts",
    pattern: /CAST\s*\(\s*j?\.?ExpectedProgressUpdate\s+AS\s+DATE\s*\)/i,
    reason: "wrap of indexed column blocks seek on IX_Jobs_ExpectedProgressUpdate",
  },
  {
    file: "src/functions/users.ts",
    pattern: /LOWER\s*\(\s*Email\s*\)/i,
    reason: "wrap of indexed column blocks seek on UX_AppUsers_Email_Active; app already lowercases input",
  },
];

describe("no non-sargable patterns in handlers", () => {
  for (const ban of BANS) {
    test(`${ban.file} does not match ${ban.pattern}`, () => {
      const abs = join(__dirname, "..", "..", ban.file);
      const source = readFileSync(abs, "utf8");
      const match = source.match(ban.pattern);
      assert.strictEqual(
        match,
        null,
        `${ban.file} contains banned pattern (${ban.reason}): ${match?.[0] ?? ""}`,
      );
    });
  }
});
