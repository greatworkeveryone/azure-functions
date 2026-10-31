/// <reference types="jest" />
// Migration 191 (office closures + NT public holiday seed) is applied by hand: additive, insert-only, safe to run twice.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findDestructiveStatements } from "../migrate-files";

const raw = readFileSync(join(__dirname, "..", "..", "migrations", "191_office_closures.sql"), "utf8");
const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

describe("migration 191", () => {
  it("has no destructive statement and rewrites no existing value", () => {
    expect(findDestructiveStatements(raw)).toEqual([]);
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|DELETE|UPDATE)\b/i);
    expect(code).not.toMatch(/ALTER\s+COLUMN|sp_rename/i);
  });
  it("guards the table and index, with the date and kind checks", () => {
    expect(code).toMatch(/IF OBJECT_ID\('dbo\.OfficeClosures', 'U'\) IS NULL\s+BEGIN\s+CREATE TABLE/);
    expect(code).toMatch(/IF NOT EXISTS \(SELECT 1 FROM sys\.indexes WHERE name = 'IX_OfficeClosures_Live'/);
    expect(code).toMatch(/CHECK \(EndsOn >= StartsOn\)/);
    expect(code).toMatch(/Kind IN \(N'public_holiday', N'shutdown'\)/);
    expect(code).toMatch(/ROWVERSION/);
  });
  it("seeds with an insert-only MERGE, so a re-run never overwrites an edit", () => {
    expect(code).toMatch(/MERGE dbo\.OfficeClosures/);
    expect(code).toMatch(/WHEN NOT MATCHED BY TARGET THEN\s+INSERT/);
    expect(code).not.toMatch(/WHEN MATCHED/);
  });
  it("seeds only weekday NT public holidays (with Darwin Show Day) for 2026 to 2028, none of them part-day, and cites its source", () => {
    const dates = [...code.matchAll(/CAST\('(\d{4}-\d{2}-\d{2})' AS DATE\)/g)].map((m) => m[1]);
    expect(dates.length).toBe(32);
    expect(dates).toContain("2027-04-26"); // Anzac Day 2027 falls on a Sunday; the Monday is the holiday
    expect(dates).toContain("2026-07-24"); // Darwin Show Day
    for (const d of dates) {
      expect(["2026", "2027", "2028"]).toContain(d.slice(0, 4));
      const weekday = new Date(`${d}T00:00:00Z`).getUTCDay();
      expect(weekday).toBeGreaterThanOrEqual(1);
      expect(weekday).toBeLessThanOrEqual(5);
    }
    expect(dates).not.toContain("2026-12-24");
    expect(dates).not.toContain("2026-12-31");
    expect(raw).toMatch(/https:\/\/nt\.gov\.au\/nt-public-holidays/);
  });
});
