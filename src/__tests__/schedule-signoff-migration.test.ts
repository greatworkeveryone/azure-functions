/// <reference types="jest" />
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Migration 097 is applied by hand, and there is no SQL Server in the unit
// tests. Pin what can be pinned: it only adds, it can run twice, and the new
// columns are optional so every existing tenancy simply reads as not signed off.

const sql = readFileSync(join(__dirname, "..", "..", "migrations", "097_schedule_signoff.sql"), "utf8");
const code = sql
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

const COLUMNS: Array<[string, string]> = [
  ["ScheduleSignedOffAt", "DATETIME2"],
  ["ScheduleSignedOffById", "NVARCHAR(200)"],
  ["ScheduleSignedOffByName", "NVARCHAR(200)"],
  ["ScheduleSignOffNote", "NVARCHAR(500)"],
];

describe("migration 097: schedule sign-off", () => {
  it.each(COLUMNS)("adds %s as a nullable %s, only if it is missing", (column, type) => {
    expect(code).toContain(`IF COL_LENGTH('dbo.Tenants', '${column}') IS NULL`);
    expect(code).toContain(`ALTER TABLE dbo.Tenants ADD ${column} ${type} NULL;`);
  });

  it("puts each column in a batch of its own", () => {
    const batches = code.split(/^GO\s*$/m).filter((batch) => batch.trim() !== "");
    expect(batches).toHaveLength(COLUMNS.length);
  });

  it("changes no existing data and removes nothing", () => {
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|DELETE|UPDATE|ALTER COLUMN|sp_rename|NOT NULL|DEFAULT)\b/i);
  });
});
