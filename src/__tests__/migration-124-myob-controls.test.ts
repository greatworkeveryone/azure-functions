/// <reference types="jest" />
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Migration 124 against the code that reads and writes its tables, and the
// defaults decision 7 and 14 depend on (everything off until the CFO says so).

const read = (path: string) => readFileSync(join(__dirname, "..", "..", path), "utf8");
const sql = read("migrations/124_myob_controls.sql").replace(/--[^\n]*/g, "");
const authTable = sql + read("migrations/046_myob_auth.sql").replace(/--[^\n]*/g, "");

describe("migration 124_myob_controls.sql", () => {
  it("has every MyobAuth column myob-auth-store.ts selects", () => {
    const store = read("src/myob-auth-store.ts");
    const select = /SELECT ([\s\S]*?)\s+FROM dbo\.MyobAuth/.exec(store);
    expect(select).not.toBeNull();
    for (const column of (select as RegExpExecArray)[1].split(",").map((c) => c.trim())) {
      expect(authTable).toMatch(new RegExp(`\\b${column}\\b`));
    }
  });

  it("has every MyobAuthStates column myob-auth-state.ts uses", () => {
    for (const column of ["StateHash", "StartedByOid", "StartedByName", "ExpiresAt", "ConsumedAt"]) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE dbo\\.MyobAuthStates[\\s\\S]*\\b${column}\\b`));
    }
  });

  it("starts every company file off and every control off, in dry run, under review, with no allowance", () => {
    expect(sql).toMatch(/DF_MyobCompanyFiles_Mode DEFAULT N'off'/);
    expect(sql).toMatch(/DF_MyobControls_Enabled DEFAULT 0/);
    expect(sql).toMatch(/DF_MyobControls_DryRun DEFAULT 1/);
    expect(sql).toMatch(/DF_MyobControls_RequireReview DEFAULT 1/);
    expect(sql).toMatch(/DF_MyobControls_DailyCap DEFAULT 0/);
    expect(sql).toMatch(/DF_MyobControls_PausedAll DEFAULT 0/);
  });

  it("allows only the agreed operations: no delete, attach, sales or other centre", () => {
    const check = /CK_MyobControls_Operation CHECK \(Operation IN \(([\s\S]*?)\)\)/.exec(sql);
    expect(check).not.toBeNull();
    const operations = (check as RegExpExecArray)[1].match(/N'([^']+)'/g)?.map((o) => o.slice(2, -1));
    expect(operations).toEqual([
      "quotes.create",
      "quotes.update",
      "orders.create",
      "orders.update",
      "bills.create",
      "purchases.read",
      "lab.enabled",
    ]);
  });

  it("keys controls by file and operation, and hangs them off MyobCompanyFiles", () => {
    expect(sql).toMatch(/PK_MyobControls PRIMARY KEY \(CompanyFileId, Operation\)/);
    expect(sql).toMatch(/FK_MyobControls_CompanyFile REFERENCES dbo\.MyobCompanyFiles \(CompanyFileId\)/);
  });

  it("versions the shared control rows for 409-on-stale writes", () => {
    expect(sql).toMatch(/CREATE TABLE dbo\.MyobCompanyFiles[\s\S]*RowVersion\s+ROWVERSION/);
    expect(sql).toMatch(/CREATE TABLE dbo\.MyobControls[\s\S]*RowVersion\s+ROWVERSION/);
  });
});
