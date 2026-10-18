/// <reference types="jest" />
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Migration 142 is applied by hand and there is no SQL Server in the unit tests.
// Pin what can be pinned: it only adds, it can run twice, and the new columns are
// optional, so every existing procedure version reads as having no request.

const sql = readFileSync(join(__dirname, "..", "..", "migrations", "142_procedure_approval_request.sql"), "utf8");
const code = sql
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

const COLUMNS: Array<[string, string]> = [
  ["ApprovalRequestedAt", "DATETIME2(0)"],
  ["ApprovalRequestedBy", "NVARCHAR(256)"],
  ["ApprovalRequestedFromUserId", "INT"],
  ["ApprovalRequestedFromName", "NVARCHAR(256)"],
];

describe("migration 142: procedure approval request", () => {
  it.each(COLUMNS)("adds %s as a nullable %s, only if it is missing", (column, type) => {
    expect(code).toContain(`IF COL_LENGTH('dbo.ProcedureVersions', '${column}') IS NULL`);
    expect(code).toContain(`ALTER TABLE dbo.ProcedureVersions ADD ${column} ${type} NULL;`);
  });

  it("puts each column in a batch of its own", () => {
    const batches = code.split(/^GO\s*$/m).filter((batch) => batch.trim() !== "");
    expect(batches).toHaveLength(COLUMNS.length);
  });

  it("changes no existing data and removes nothing", () => {
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|DELETE|UPDATE|ALTER COLUMN|sp_rename|NOT NULL|DEFAULT)\b/i);
  });
});
