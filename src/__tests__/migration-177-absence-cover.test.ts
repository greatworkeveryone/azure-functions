/// <reference types="jest" />
// Migration 177 (dbo.CoverDelegates, dbo.CoverActions, the cover.moved policy; AW1) is applied by
// hand and must never fail because the database refuses ledger tables, nor change anything that
// exists. These read the file as text; the two runs against a local database (apply, apply again)
// are recorded in the package report.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COVER_ACTIONS, ITEM_TYPES } from "../absenceCover/types";
import { findDestructiveStatements } from "../migrate-files";

const raw = readFileSync(join(__dirname, "..", "..", "migrations", "177_absence_cover.sql"), "utf8");
const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
const columnsSql = (raw.match(/DECLARE @cols NVARCHAR\(MAX\) = N'([\s\S]*?)';/)?.[1] ?? "").replace(/''/g, "'");
const listIn = (constraint: string): string[] => {
  const found = columnsSql.match(new RegExp(`${constraint} CHECK \\(\\w+ IN \\(([^)]*)\\)`))?.[1] ?? "";
  return [...found.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
};

describe("migration 177 is additive and re-runnable", () => {
  it("has no destructive statement", () => {
    expect(findDestructiveStatements(raw)).toEqual([]);
    // The one UPDATE and DELETE in the file are the fallback trigger's refusal of them.
    const withoutTrigger = code.replace(/EXEC\(N'CREATE TRIGGER[^\n]*\n/, "");
    expect(withoutTrigger).not.toMatch(/\b(DROP|TRUNCATE|DELETE)\b/i);
    expect(withoutTrigger).not.toMatch(/\bUPDATE\b/i);
    expect(code).not.toMatch(/ALTER\s+COLUMN|sp_rename/i);
  });

  it("creates each table and index only when it is not there", () => {
    expect(code.match(/CREATE TABLE dbo\.CoverDelegates/g)).toHaveLength(1);
    expect(code).toMatch(/IF OBJECT_ID\('dbo\.CoverDelegates', 'U'\) IS NULL\s+BEGIN\s+CREATE TABLE dbo\.CoverDelegates/);
    expect(code.match(/IF OBJECT_ID\('dbo\.CoverActions', 'U'\) IS NULL/g)).toHaveLength(2);
    const indexes = [...code.matchAll(/IF NOT EXISTS \(SELECT 1 FROM sys\.indexes WHERE name = '(\w+)'[^)]*\)\)\s+CREATE (?:UNIQUE )?INDEX (\w+)/g)];
    expect(indexes.map((match) => [match[1], match[2]])).toEqual(indexes.map((match) => [match[1], match[1]]));
    expect(code.match(/CREATE INDEX/g)).toHaveLength(indexes.length);
    expect(indexes.map((match) => match[1])).toEqual(["IX_CoverDelegates_User", "IX_CoverDelegates_Delegate", "IX_CoverActions_Item", "IX_CoverActions_From", "IX_CoverActions_To"]);
  });

  it("seeds the notice policy without overwriting an admin's edit", () => {
    expect(code).toContain("MERGE dbo.EscalationPolicies");
    expect(code).toContain("WHEN NOT MATCHED BY TARGET THEN");
    expect(code).not.toMatch(/WHEN MATCHED/);
    expect(code).toContain("N'cover.moved', N'attention', 0, N'business', N'no', N'[{\"userTarget\":true}]', 1");
  });

  it("ends a nomination by archiving it: there is no delete, and archive columns come in a pair", () => {
    expect(code).toContain("ArchivedAt       DATETIME2(3)  NULL");
    expect(code).toMatch(/CK_CoverDelegates_Archived CHECK \(\s*\(ArchivedAt IS NULL AND ArchivedBy IS NULL\) OR \(ArchivedAt IS NOT NULL AND ArchivedBy IS NOT NULL\)/);
    expect(code).toContain("CK_CoverDelegates_NotSelf CHECK (DelegateUserId <> UserId)");
    expect(code).toContain("CK_CoverDelegates_Dates CHECK (ToDate >= FromDate)");
  });
});

describe("migration 177 can't stop the API", () => {
  it("tries an append-only ledger table first, then without the extra option, then a trigger fallback", () => {
    const attempts = [...code.matchAll(/EXEC\(N'CREATE TABLE dbo\.CoverActions \(' \+ @cols \+ N'\)([^']*)'\);/g)];
    expect(attempts.map((attempt) => attempt[1])).toEqual([" WITH (SYSTEM_VERSIONING = OFF, LEDGER = ON (APPEND_ONLY = ON));", " WITH (LEDGER = ON (APPEND_ONLY = ON));", ";"]);
    expect(code.match(/DECLARE @cols/g)).toHaveLength(1);
  });

  it("makes the fallback table and its trigger atomic, and the trigger refuses UPDATE and DELETE", () => {
    expect(code).toContain("EXEC(N'CREATE TRIGGER dbo.TR_CoverActions_AppendOnly ON dbo.CoverActions INSTEAD OF UPDATE, DELETE AS BEGIN THROW 51000, ''CoverActions is append-only'', 1; END;');");
    const fallback = code.slice(code.indexOf("BEGIN TRANSACTION;"), code.indexOf("COMMIT TRANSACTION;"));
    expect(fallback.indexOf("CREATE TRIGGER")).toBeGreaterThan(fallback.indexOf("CREATE TABLE"));
    expect(code.slice(code.lastIndexOf("BEGIN CATCH"))).toMatch(/IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;\s*THROW;/);
  });

  it("keeps the ledger free of foreign keys, which an append-only table cannot carry reliably", () => {
    expect(columnsSql).not.toMatch(/FOREIGN KEY|REFERENCES/i);
  });
});

describe("the table agrees with the code", () => {
  it("allows exactly the item types the engine knows", () => {
    expect(listIn("CK_CoverActions_ItemType")).toEqual([...ITEM_TYPES]);
  });

  it("allows exactly the actions the ledger records", () => {
    expect(listIn("CK_CoverActions_Action")).toEqual([...COVER_ACTIONS]);
  });

  it("allows the three absence kinds, three importances and two actors", () => {
    expect(listIn("CK_CoverActions_AbsenceKind")).toEqual(["planned", "unplanned", "inactive"]);
    expect(listIn("CK_CoverActions_Importance")).toEqual(["high", "medium", "low"]);
    expect(listIn("CK_CoverActions_ActorKind")).toEqual(["system", "user"]);
  });

  it("holds every column the store writes", () => {
    const store = readFileSync(join(__dirname, "..", "absenceCover", "coverActionStore.ts"), "utf8");
    const written = store.match(/INSERT INTO dbo\.CoverActions \(([^)]*)\)/)?.[1].split(",").map((name) => name.trim()) ?? [];
    expect(written.length).toBeGreaterThan(15);
    for (const column of written) expect(columnsSql).toMatch(new RegExp(`\\b${column}\\s+(BIGINT|NVARCHAR|INT|DATE|DATETIME2|UNIQUEIDENTIFIER|BIT)`));
  });
});
