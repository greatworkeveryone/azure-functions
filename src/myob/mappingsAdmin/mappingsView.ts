// The mappings as Admin → MYOB → Mappings shows them, and the same rows as the
// CSV Johanne exports (which is also the import template). Registered files
// only: every mapping table has a foreign key to MyobCompanyFiles.

import type { Connection } from "tedious";
import { executeQuery, type SqlRow } from "../../db";
import { darwinDateKey } from "../../escalation/businessTime";
import { CHARGE_CODES } from "../../reference-codes";
import { toCsv } from "./csv";
import { KINDS, type MappingKind } from "./mappingKinds";

export interface MappingsView {
  columns: { key: string; label: string }[];
  kind: MappingKind;
  rows: { id: string; values: Record<string, string> }[];
}

const SQL: Record<MappingKind, string> = {
  accounts: `SELECT m.CompanyFileId, f.Name AS FileName, m.ChargeCode, m.AccountUid, m.AccountDisplayId, m.AccountName, m.TaxCodeUid, m.TaxCode, m.ApprovedBy AS ByName, m.ApprovedAt AS AtTime
               FROM dbo.ChargeCodeAccount m JOIN dbo.MyobCompanyFiles f ON f.CompanyFileId = m.CompanyFileId ORDER BY f.Name, m.ChargeCode`,
  buildings: `SELECT m.BuildingID, b.BuildingName, m.CompanyFileId, f.Name AS FileName, m.MappedBy AS ByName, m.MappedAt AS AtTime
                FROM dbo.BuildingCompanyFile m JOIN dbo.MyobCompanyFiles f ON f.CompanyFileId = m.CompanyFileId
                LEFT JOIN dbo.Buildings b ON b.BuildingID = m.BuildingID ORDER BY b.BuildingName, m.BuildingID`,
  suppliers: `SELECT m.CompanyFileId, f.Name AS FileName, m.ContractorID, c.ContractorName, m.SupplierUid, m.SupplierName, m.Abn, m.TaxCodeUid, m.TaxCode,
                     m.MatchBasis, m.ConfirmedBy AS ByName, m.ConfirmedAt AS AtTime
                FROM dbo.ContractorMyobSupplier m JOIN dbo.MyobCompanyFiles f ON f.CompanyFileId = m.CompanyFileId
                LEFT JOIN dbo.Contractors c ON c.ContractorID = m.ContractorID ORDER BY f.Name, c.ContractorName, m.ContractorID`,
};

const s = (value: unknown) => (value === null || value === undefined ? "" : String(value));
const when = (value: unknown) => (value instanceof Date ? `${darwinDateKey(value)}` : s(value));

const DISPLAY: Record<MappingKind, { columns: [string, string][]; row: (r: SqlRow) => Record<string, string> }> = {
  accounts: {
    columns: [["file", "Company file"], ["chargeCode", "Charge code"], ["account", "MYOB account"], ["taxCode", "Tax code"], ["by", "Approved by"]],
    row: (r) => ({
      account: [s(r.AccountDisplayId), s(r.AccountName)].filter(Boolean).join(" ") || s(r.AccountUid),
      by: [s(r.ByName), when(r.AtTime)].filter(Boolean).join(" · "),
      chargeCode: `${s(r.ChargeCode)} · ${CHARGE_CODES[s(r.ChargeCode)] ?? "unknown code"}`,
      file: s(r.FileName) || s(r.CompanyFileId),
      taxCode: s(r.TaxCode),
    }),
  },
  buildings: {
    columns: [["building", "Building"], ["file", "Company file"], ["by", "Mapped by"]],
    row: (r) => ({ building: s(r.BuildingName) || `Building ${s(r.BuildingID)}`, by: [s(r.ByName), when(r.AtTime)].filter(Boolean).join(" · "), file: s(r.FileName) || s(r.CompanyFileId) }),
  },
  suppliers: {
    columns: [["file", "Company file"], ["contractor", "Contractor"], ["supplier", "MYOB supplier"], ["abn", "ABN"], ["taxCode", "Tax code"], ["match", "Matched by"], ["by", "Confirmed by"]],
    row: (r) => ({
      abn: s(r.Abn),
      by: [s(r.ByName), when(r.AtTime)].filter(Boolean).join(" · "),
      contractor: s(r.ContractorName) || `Contractor ${s(r.ContractorID)}`,
      file: s(r.FileName) || s(r.CompanyFileId),
      match: r.MatchBasis === "abn" ? "ABN" : "By hand",
      supplier: s(r.SupplierName),
      taxCode: s(r.TaxCode),
    }),
  },
};

const ID: Record<MappingKind, (r: SqlRow) => string> = {
  accounts: (r) => `${s(r.CompanyFileId).toLowerCase()}|${s(r.ChargeCode)}`,
  buildings: (r) => s(r.BuildingID),
  suppliers: (r) => `${s(r.CompanyFileId).toLowerCase()}|${s(r.ContractorID)}`,
};

/** CSV cells in the import template's column order. */
const CSV_CELL: Record<string, (r: SqlRow) => string> = {
  abn: (r) => s(r.Abn), account_display_id: (r) => s(r.AccountDisplayId), account_name: (r) => s(r.AccountName), account_uid: (r) => s(r.AccountUid),
  building_id: (r) => s(r.BuildingID), building_name: (r) => s(r.BuildingName), charge_code: (r) => s(r.ChargeCode),
  company_file_id: (r) => s(r.CompanyFileId).toLowerCase(), contractor_id: (r) => s(r.ContractorID), contractor_name: (r) => s(r.ContractorName),
  supplier_name: (r) => s(r.SupplierName), supplier_uid: (r) => s(r.SupplierUid), tax_code: (r) => s(r.TaxCode), tax_code_uid: (r) => s(r.TaxCodeUid),
};

export async function loadMappingsView(connection: Connection, kind: MappingKind): Promise<MappingsView> {
  const rows = await executeQuery(connection, SQL[kind]);
  const display = DISPLAY[kind];
  return {
    columns: display.columns.map(([key, label]) => ({ key, label })),
    kind,
    rows: rows.map((row) => ({ id: ID[kind](row), values: display.row(row) })),
  };
}

export async function exportMappingsCsv(connection: Connection, kind: MappingKind, now = new Date()): Promise<{ filename: string; text: string }> {
  const rows = await executeQuery(connection, SQL[kind]);
  const columns = KINDS[kind].columns;
  return { filename: `floorplan-myob-${kind}-${darwinDateKey(now)}.csv`, text: toCsv(columns, rows.map((row) => columns.map((column) => CSV_CELL[column](row)))) };
}
