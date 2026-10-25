/// <reference types="jest" />
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Migrations 125 (mappings) and 126 (proposals) against the code that reads
// and writes them.

const read = (path: string) => readFileSync(join(__dirname, "..", "..", path), "utf8");
const strip = (sql: string) => sql.replace(/--[^\n]*/g, "");
const m125 = strip(read("migrations/125_myob_reference_cache.sql"));
const m126 = strip(read("migrations/126_myob_proposals.sql"));

const columnsIn = (sql: string, table: string) => {
  const body = new RegExp(`CREATE TABLE dbo\\.${table} \\(([\\s\\S]*?)\\n  \\);`).exec(sql)?.[1] ?? "";
  return body;
};

describe("migration 125_myob_reference_cache.sql", () => {
  it("has every mapping column myob/mappings.ts reads, keyed per company file", () => {
    const code = read("src/myob/mappings.ts");
    for (const [table, columns] of Object.entries({
      BuildingCompanyFile: ["BuildingID", "CompanyFileId"],
      ChargeCodeAccount: ["CompanyFileId", "ChargeCode", "AccountUid", "AccountDisplayId", "AccountName", "TaxCodeUid", "TaxCode"],
      ContractorMyobSupplier: ["CompanyFileId", "ContractorID", "SupplierUid", "SupplierName", "TaxCodeUid", "TaxCode"],
    })) {
      expect(code).toContain(`dbo.${table}`);
      for (const column of columns) expect(columnsIn(m125, table)).toMatch(new RegExp(`\\b${column}\\b`));
    }
    expect(m125).toMatch(/PK_ContractorMyobSupplier PRIMARY KEY \(CompanyFileId, ContractorID\)/);
    expect(m125).toMatch(/PK_ChargeCodeAccount PRIMARY KEY \(CompanyFileId, ChargeCode\)/);
  });

  it("records who confirmed every mapping", () => {
    expect(columnsIn(m125, "ContractorMyobSupplier")).toMatch(/ConfirmedBy\s+NVARCHAR\(200\)\s+NOT NULL/);
    expect(columnsIn(m125, "ChargeCodeAccount")).toMatch(/ApprovedBy\s+NVARCHAR\(200\)\s+NOT NULL/);
    expect(columnsIn(m125, "BuildingCompanyFile")).toMatch(/MappedBy\s+NVARCHAR\(200\)\s+NOT NULL/);
  });
});

describe("migration 126_myob_proposals.sql", () => {
  it("has every column myob/proposalsStore.ts reads and writes", () => {
    const code = read("src/myob/proposalRow.ts");
    const select = /PROPOSAL_COLUMNS = `([\s\S]*?)`/.exec(code)?.[1] ?? "";
    const columns = select.split(",").map((c) => c.trim()).filter(Boolean);
    expect(columns.length).toBeGreaterThan(20);
    for (const column of [...columns, "WithdrawnBy", "WithdrawnAt", "WithdrawReason", "ReviewedByOid", "MyobSnapshot", "Discrepancy", "MyobStatus"]) {
      expect(columnsIn(m126, "MyobProposals")).toMatch(new RegExp(`\\b${column}\\b`));
    }
  });

  it("allows only the agreed operations and states, and no delete operation", () => {
    expect(m126).toMatch(/Operation IN \(\s*N'quotes\.create', N'orders\.create', N'bills\.create', N'quotes\.update', N'orders\.update'\)/);
    expect(m126).toMatch(/State IN \(\s*N'proposed', N'approved', N'pushed', N'verified', N'exception', N'withdrawn'\)/);
    expect(m126).not.toMatch(/delete/i);
  });

  it("keeps JSON columns valid and one live proposal per record and operation", () => {
    for (const column of ["Payload", "Rendered"]) expect(m126).toMatch(new RegExp(`ISJSON\\(${column}\\) = 1`));
    expect(m126).toMatch(/UX_MyobProposals_OpenSubject ON dbo\.MyobProposals \(SubjectType, SubjectId, Operation\) WHERE State IN \(N''proposed'', N''approved'', N''pushed''\)/);
  });

  it("versions every row for 409-on-stale writes", () => {
    expect(columnsIn(m126, "MyobProposals")).toMatch(/RowVersion\s+ROWVERSION/);
  });
});
