/// <reference types="jest" />

jest.mock("../../db", () => ({ executeQuery: jest.fn() }));

import { exportMappingsCsv, loadMappingsView } from "./mappingsView";

const { executeQuery } = require("../../db") as { executeQuery: jest.Mock };
const DEMO = "0F9E8D7C-6B5A-4F3E-9D2C-1B0A99887766";
const SUP = "44444444-2222-4333-8444-555555555555";
const ROW = {
  Abn: "51824753556", AtTime: new Date("2026-10-16T23:00:00Z"), ByName: "Johanne", CompanyFileId: DEMO, ContractorID: 12, ContractorName: "=ACME Air",
  FileName: "Demo Pty Ltd", MatchBasis: "abn", SupplierName: "ACME Air Pty Ltd", SupplierUid: SUP, TaxCode: "GST", TaxCodeUid: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  executeQuery.mockResolvedValue([ROW]);
});

describe("loadMappingsView", () => {
  it("shows registered files' mappings only, in the CFO's words", async () => {
    const view = await loadMappingsView({} as never, "suppliers");
    expect(String(executeQuery.mock.calls[0][1]).replace(/\s+/g, " ")).toMatch(/FROM dbo\.ContractorMyobSupplier m JOIN dbo\.MyobCompanyFiles f ON f\.CompanyFileId = m\.CompanyFileId/);
    expect(view.columns.map((column) => column.label)).toEqual(["Company file", "Contractor", "MYOB supplier", "ABN", "Tax code", "Matched by", "Confirmed by"]);
    expect(view.rows).toEqual([{ id: `${DEMO.toLowerCase()}|12`, values: expect.objectContaining({ by: "Johanne · 2026-10-17", file: "Demo Pty Ltd", match: "ABN", supplier: "ACME Air Pty Ltd" }) }]);
  });

  it.each([["accounts", "ChargeCodeAccount"], ["buildings", "BuildingCompanyFile"]] as const)("reads %s through a join on registered files", async (kind, table) => {
    await loadMappingsView({} as never, kind);
    expect(String(executeQuery.mock.calls[0][1]).replace(/\s+/g, " ")).toMatch(new RegExp(`FROM dbo\\.${table} m JOIN dbo\\.MyobCompanyFiles f ON f\\.CompanyFileId = m\\.CompanyFileId`));
  });
});

describe("exportMappingsCsv", () => {
  it("is the import template's columns, in order, with today's Darwin date in the name, and no spreadsheet formulas", async () => {
    const csv = await exportMappingsCsv({} as never, "suppliers", new Date("2026-10-16T23:00:00Z"));
    expect(csv.filename).toBe("floorplan-myob-suppliers-2026-10-17.csv");
    expect(csv.text).toBe(
      "company_file_id,contractor_id,contractor_name,supplier_uid,supplier_name,abn,tax_code_uid,tax_code\r\n" +
        `${DEMO.toLowerCase()},12,'=ACME Air,${SUP},ACME Air Pty Ltd,51824753556,,GST\r\n`,
    );
  });
});
