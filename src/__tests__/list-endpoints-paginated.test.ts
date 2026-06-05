import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Regression guard: every list endpoint must import + use parsePagination so
// the safety ceiling is enforced and pagination is opt-in via ?page=&pageSize=.
const REQUIRED_HITS = ["parsePagination", "MAX_LIST_ROWS"];
const FILES = [
  "src/functions/jobs.ts",
  "src/functions/invoices.ts",
  "src/functions/quotes.ts",
  "src/functions/workRequests.ts",
];

describe("list endpoints use the pagination helper", () => {
  for (const relPath of FILES) {
    for (const needle of REQUIRED_HITS) {
      test(`${relPath} references ${needle}`, () => {
        const abs = join(__dirname, "..", "..", relPath);
        const source = readFileSync(abs, "utf8");
        assert.ok(
          source.includes(needle),
          `${relPath} is missing the ${needle} reference — list endpoint not wired to ../pagination`,
        );
      });
    }
  }
});
