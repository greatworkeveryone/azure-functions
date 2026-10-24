/// <reference types="jest" />
import { readFileSync } from "node:fs";
import { join } from "node:path";

// docs/runbooks/switches.md has a row for every setting the cover engine reads, and says what
// each does and does not do. A setting added to src/absenceCover/config.ts without a row fails
// here, so an operator is never left to find it in the code.

const ROOT = join(__dirname, "..", "..");
const doc = readFileSync(join(ROOT, "docs", "runbooks", "switches.md"), "utf8");
const config = readFileSync(join(ROOT, "src", "absenceCover", "config.ts"), "utf8");

const rows = new Map<string, string>();
for (const line of doc.split("\n")) {
  const found = line.match(/^\|\s*`(ABSENCE_[A-Z_]+)`\s*\|(.*)$/);
  if (found) rows.set(found[1], found[2]);
}
const settingsRead = [...new Set([...config.matchAll(/env\.(ABSENCE_[A-Z_]+)/g)].map((found) => found[1]))].sort();

describe("switches.md rows for cover while away", () => {
  it("finds the four settings the engine reads", () => {
    expect(settingsRead).toEqual(["ABSENCE_COVER_DRY_RUN", "ABSENCE_COVER_ENABLED", "ABSENCE_COVER_MAX_ACTIONS", "ABSENCE_INACTIVITY_DAYS"]);
  });

  it.each(settingsRead)("has a row for %s that says what it does", (name) => {
    expect(rows.get(name)?.length ?? 0).toBeGreaterThan(80);
  });

  it("says the main switch is off by default and that nothing is ever approved", () => {
    const row = rows.get("ABSENCE_COVER_ENABLED") ?? "";
    expect(row).toMatch(/^\s*off\s*\|/);
    expect(row).toMatch(/Nothing is ever approved/);
    expect(row).toMatch(/migration 177/);
  });

  it("says the dry run wins and moves nothing", () => {
    const row = rows.get("ABSENCE_COVER_DRY_RUN") ?? "";
    expect(row).toMatch(/Wins over `ABSENCE_COVER_ENABLED`/);
    expect(row).toMatch(/moves nothing/);
  });

  it("lists the flag, and what is not covered yet", () => {
    expect(doc).toMatch(/Cover while away \(`absenceCover`/);
    expect(doc).toMatch(/Not covered yet: leave\s+approvals/);
  });
});
