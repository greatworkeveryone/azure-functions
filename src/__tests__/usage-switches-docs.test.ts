/// <reference types="jest" />
import { readFileSync } from "node:fs";
import { join } from "node:path";

// docs/runbooks/switches.md has a row for every setting usage analytics reads, and says what each
// does and does not do. A setting added to src/usage/config.ts without a row fails here.

const ROOT = join(__dirname, "..", "..");
const doc = readFileSync(join(ROOT, "docs", "runbooks", "switches.md"), "utf8");
const config = readFileSync(join(ROOT, "src", "usage", "config.ts"), "utf8");

const rows = new Map<string, string>();
for (const line of doc.split("\n")) {
  const found = line.match(/^\|\s*`(USAGE_[A-Z_]+)`[^|]*\|(.*)$/);
  if (found) rows.set(found[1], found[2]);
}
const settingsRead = [...new Set([...config.matchAll(/env\.(USAGE_[A-Z_]+)/g)].map((found) => found[1]))].sort();

describe("switches.md rows for usage analytics", () => {
  it("finds the four settings the code reads", () => {
    expect(settingsRead).toEqual(["USAGE_PURGE_DRY_RUN", "USAGE_PURGE_ENABLED", "USAGE_RETENTION_DAYS", "USAGE_TRACKING_ENABLED"]);
  });

  it.each(["USAGE_TRACKING_ENABLED", "USAGE_RETENTION_DAYS", "USAGE_PURGE_ENABLED"])("has a row for %s that says what it does", (name) => {
    expect(rows.get(name)?.length ?? 0).toBeGreaterThan(80);
  });

  it("says tracking is off by default, what is never recorded, and that migration 178 comes first", () => {
    const row = rows.get("USAGE_TRACKING_ENABLED") ?? "";
    expect(row).toMatch(/^\s*off\s*\|/);
    expect(row).toMatch(/Never what a person types/);
    expect(row).toMatch(/migration 178/);
  });

  it("says the purge only takes raw rows past retention, only for rolled-up days, never the roll-ups, and that the dry run wins", () => {
    const row = rows.get("USAGE_PURGE_ENABLED") ?? "";
    expect(row).toMatch(/^\s*off\s*\|/);
    expect(row).toMatch(/already rolled up/);
    expect(row).toMatch(/never touches `UsageDaily`/);
    expect(row).toMatch(/`USAGE_PURGE_DRY_RUN` wins/);
  });

  it("describes the flag, the scopes and the staff notice", () => {
    expect(doc).toMatch(/Usage analytics \(`usageAnalytics`/);
    expect(doc).toMatch(/the CFO sees\s+Finance usage only/);
    expect(doc).toMatch(/What's new and in the Overview guide/);
  });
});
