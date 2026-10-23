/// <reference types="jest" />
import { readFileSync } from "node:fs";
import { join } from "node:path";

// docs/runbooks/switches.md has one row for every setting the AI gateway reads, and the rows for
// the switches say what they do and do not do (review L3, L4). A setting added to src/ai/config.ts
// without a row fails here, so an operator is never left to find it in the code.

const ROOT = join(__dirname, "..", "..");
const doc = readFileSync(join(ROOT, "docs", "runbooks", "switches.md"), "utf8");
const config = readFileSync(join(ROOT, "src", "ai", "config.ts"), "utf8");

const rows = new Map<string, string>();
for (const line of doc.split("\n")) {
  const found = line.match(/^\|\s*`(AI_[A-Z_]+)`\s*\|(.*)$/);
  if (found) rows.set(found[1], found[2]);
}
const rowFor = (name: string) => rows.get(name) ?? "";

describe("switches.md rows for the AI gateway", () => {
  const settingsRead = [...new Set([...config.matchAll(/env\.(AI_[A-Z_]+)/g)].map((found) => found[1]))].sort();

  it("finds the settings the gateway reads", () => {
    expect(settingsRead).toEqual(
      expect.arrayContaining(["AI_API_KEY", "AI_BASE_URL", "AI_ENABLED", "AI_MODEL", "AI_PROVIDER", "AI_PURPOSES_ENABLED", "AI_RATE_PER_MINUTE", "AI_TIMEOUT_MS"]),
    );
  });

  it.each(settingsRead)("has a row for %s", (name) => {
    expect(rowFor(name).length).toBeGreaterThan(40);
  });

  it("has no row for the removed AI_LOG_CONTENT setting", () => {
    expect(rows.has("AI_LOG_CONTENT")).toBe(false);
    expect(config).not.toMatch(/AI_LOG_CONTENT/);
  });

  it("says AI_ENABLED is global and switches no purpose on by itself", () => {
    const row = rowFor("AI_ENABLED");
    expect(row).toMatch(/AI_PURPOSES_ENABLED/);
    expect(row).toMatch(/no purpose|none of the purposes|no purposes/i);
  });

  it("says AI_PURPOSES_ENABLED lists purposes by id, defaults to none, has no wildcard, and is checked after AI_ENABLED", () => {
    const row = rowFor("AI_PURPOSES_ENABLED");
    expect(row).toMatch(/comma/i);
    expect(row).toMatch(/none/i);
    expect(row).toMatch(/no wildcard|no "all"|there is no all/i);
    expect(row).toMatch(/AI_ENABLED/);
    expect(row).toContain("`echo_test`");
  });
});
