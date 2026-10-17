// Reads and writes for the MYOB mapping imports (plan M2), only through the
// migration-125 tables. Nothing is ever deleted: an import adds rows and
// changes rows it names; a mapping missing from the CSV stays as it was. A
// change is written only if the row is still the version the plan read
// (RowVersion), and an apply reads under UPDLOCK, HOLDLOCK so nobody adds a
// row between the check and the write.

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery, type SqlRow } from "../../db";
import { MyobControlsError } from "../../myob-controls-admin";
import type { MappingKind, MappingRefs, MappingValues } from "./mappingKinds";
import type { ImportPlan } from "./planImport";

const p = (name: string, type: (typeof TYPES)[keyof typeof TYPES], value: unknown) => ({ name, type, value });
const str = (value: unknown) => (value === null || value === undefined || value === "" ? null : String(value));
const lower = (value: unknown) => str(value)?.toLowerCase() ?? null;
const version = (value: unknown) => (Buffer.isBuffer(value) ? value.toString("base64") : String(value ?? ""));

/** The mappings in Floorplan now; an apply reads them under UPDLOCK, HOLDLOCK. */
const EXISTING: Record<MappingKind, { locked: string; plain: string }> = {
  accounts: {
    locked: "SELECT CompanyFileId, ChargeCode, AccountUid, AccountDisplayId, AccountName, TaxCodeUid, TaxCode, ApprovedBy, ApprovedAt, RowVersion FROM dbo.ChargeCodeAccount WITH (UPDLOCK, HOLDLOCK)",
    plain: "SELECT CompanyFileId, ChargeCode, AccountUid, AccountDisplayId, AccountName, TaxCodeUid, TaxCode, ApprovedBy, ApprovedAt, RowVersion FROM dbo.ChargeCodeAccount",
  },
  buildings: {
    locked: "SELECT BuildingID, CompanyFileId, MappedBy, MappedAt, RowVersion FROM dbo.BuildingCompanyFile WITH (UPDLOCK, HOLDLOCK)",
    plain: "SELECT BuildingID, CompanyFileId, MappedBy, MappedAt, RowVersion FROM dbo.BuildingCompanyFile",
  },
  suppliers: {
    locked: "SELECT CompanyFileId, ContractorID, SupplierUid, SupplierName, Abn, TaxCodeUid, TaxCode, MatchBasis, ConfirmedBy, ConfirmedAt, RowVersion FROM dbo.ContractorMyobSupplier WITH (UPDLOCK, HOLDLOCK)",
    plain: "SELECT CompanyFileId, ContractorID, SupplierUid, SupplierName, Abn, TaxCodeUid, TaxCode, MatchBasis, ConfirmedBy, ConfirmedAt, RowVersion FROM dbo.ContractorMyobSupplier",
  },
};

function existingRow(kind: MappingKind, row: SqlRow): [string, MappingValues] {
  const file = lower(row.CompanyFileId) ?? "";
  if (kind === "suppliers") {
    return [`${file}|${row.ContractorID}`, { abn: str(row.Abn), supplierName: str(row.SupplierName), supplierUid: lower(row.SupplierUid), taxCode: str(row.TaxCode), taxCodeUid: lower(row.TaxCodeUid) }];
  }
  if (kind === "accounts") {
    return [`${file}|${String(row.ChargeCode).toLowerCase()}`, {
      accountDisplayId: str(row.AccountDisplayId), accountName: str(row.AccountName), accountUid: lower(row.AccountUid), taxCode: str(row.TaxCode), taxCodeUid: lower(row.TaxCodeUid),
    }];
  }
  return [String(row.BuildingID), { companyFileId: file }];
}

export async function loadRefs(connection: Connection, kind: MappingKind, lock: boolean): Promise<MappingRefs> {
  const files = await executeQuery(connection, `SELECT CompanyFileId, Name FROM dbo.MyobCompanyFiles`);
  const contractors = kind === "suppliers" ? await executeQuery(connection, `SELECT ContractorID, ContractorName, ABN FROM dbo.Contractors`) : [];
  const buildings = kind === "buildings" ? await executeQuery(connection, `SELECT BuildingID, BuildingName FROM dbo.Buildings`) : [];
  const existing = await executeQuery(connection, lock ? EXISTING[kind].locked : EXISTING[kind].plain);
  return {
    buildings: new Map(buildings.map((row) => [Number(row.BuildingID), str(row.BuildingName) ?? `Building ${row.BuildingID}`])),
    contractors: new Map(contractors.map((row) => [Number(row.ContractorID), { abn: str(row.ABN)?.replace(/\s+/g, "") ?? null, name: str(row.ContractorName) ?? `Contractor ${row.ContractorID}` }])),
    existing: new Map(existing.map((row) => {
      const [key, values] = existingRow(kind, row);
      return [key, { rowVersion: version(row.RowVersion), values }];
    })),
    files: new Map(files.map((row) => [String(row.CompanyFileId).toLowerCase(), str(row.Name) ?? String(row.CompanyFileId)])),
  };
}

const INSERT: Record<MappingKind, string> = {
  accounts: `INSERT INTO dbo.ChargeCodeAccount (CompanyFileId, ChargeCode, AccountUid, AccountDisplayId, AccountName, TaxCodeUid, TaxCode, ApprovedBy, Note)
             OUTPUT INSERTED.ChargeCode
             SELECT @File, @Code, @AccountUid, @AccountDisplayId, @AccountName, @TaxCodeUid, @TaxCode, @By, @Note
              WHERE NOT EXISTS (SELECT 1 FROM dbo.ChargeCodeAccount WHERE CompanyFileId = @File AND ChargeCode = @Code)`,
  buildings: `INSERT INTO dbo.BuildingCompanyFile (BuildingID, CompanyFileId, MappedBy, Note)
              OUTPUT INSERTED.BuildingID
              SELECT @Building, @File, @By, @Note WHERE NOT EXISTS (SELECT 1 FROM dbo.BuildingCompanyFile WHERE BuildingID = @Building)`,
  suppliers: `INSERT INTO dbo.ContractorMyobSupplier (CompanyFileId, ContractorID, SupplierUid, SupplierName, Abn, TaxCodeUid, TaxCode, MatchBasis, ConfirmedBy, Note)
              OUTPUT INSERTED.ContractorID
              SELECT @File, @Contractor, @SupplierUid, @SupplierName, @Abn, @TaxCodeUid, @TaxCode, @MatchBasis, @By, @Note
               WHERE NOT EXISTS (SELECT 1 FROM dbo.ContractorMyobSupplier WHERE CompanyFileId = @File AND ContractorID = @Contractor)`,
};

const UPDATE: Record<MappingKind, string> = {
  accounts: `UPDATE dbo.ChargeCodeAccount SET AccountUid = @AccountUid, AccountDisplayId = @AccountDisplayId, AccountName = @AccountName,
               TaxCodeUid = @TaxCodeUid, TaxCode = @TaxCode, ApprovedBy = @By, ApprovedAt = SYSUTCDATETIME(), Note = @Note
             OUTPUT INSERTED.ChargeCode WHERE CompanyFileId = @File AND ChargeCode = @Code AND RowVersion = @RowVersion`,
  buildings: `UPDATE dbo.BuildingCompanyFile SET CompanyFileId = @File, MappedBy = @By, MappedAt = SYSUTCDATETIME(), Note = @Note
              OUTPUT INSERTED.BuildingID WHERE BuildingID = @Building AND RowVersion = @RowVersion`,
  suppliers: `UPDATE dbo.ContractorMyobSupplier SET SupplierUid = @SupplierUid, SupplierName = @SupplierName, Abn = @Abn, TaxCodeUid = @TaxCodeUid,
                TaxCode = @TaxCode, MatchBasis = @MatchBasis, ConfirmedBy = @By, ConfirmedAt = SYSUTCDATETIME(), Note = @Note
              OUTPUT INSERTED.ContractorID WHERE CompanyFileId = @File AND ContractorID = @Contractor AND RowVersion = @RowVersion`,
};

function params(kind: MappingKind, row: ImportPlan["rows"][number], by: string, note: string | null) {
  const v = row.after ?? {};
  const [file, rest] = kind === "buildings" ? [String(v.companyFileId), String(row.key)] : String(row.key).split("|");
  const common = [p("File", TYPES.NVarChar, file), p("By", TYPES.NVarChar, by.slice(0, 200)), p("Note", TYPES.NVarChar, note?.slice(0, 1000) ?? null)];
  if (row.rowVersion) common.push(p("RowVersion", TYPES.Binary, Buffer.from(row.rowVersion, "base64")));
  if (kind === "buildings") return [...common, p("Building", TYPES.Int, Number(rest))];
  const tax = [p("TaxCodeUid", TYPES.NVarChar, v.taxCodeUid ?? null), p("TaxCode", TYPES.NVarChar, v.taxCode ?? null)];
  if (kind === "accounts") {
    return [...common, ...tax, p("Code", TYPES.NVarChar, rest), p("AccountUid", TYPES.NVarChar, v.accountUid), p("AccountDisplayId", TYPES.NVarChar, v.accountDisplayId ?? null), p("AccountName", TYPES.NVarChar, v.accountName ?? null)];
  }
  return [
    ...common, ...tax, p("Contractor", TYPES.Int, Number(rest)), p("SupplierUid", TYPES.NVarChar, v.supplierUid), p("SupplierName", TYPES.NVarChar, v.supplierName),
    p("Abn", TYPES.NVarChar, v.abn ?? null), p("MatchBasis", TYPES.NVarChar, row.matchBasis ?? "manual"),
  ];
}

/** Writes the plan's adds and changes. Any row that moved since the plan was read refuses the whole import (409). */
export async function writePlan(tx: Connection, plan: ImportPlan, by: string, note: string | null): Promise<void> {
  for (const row of plan.rows) {
    if (row.outcome !== "add" && row.outcome !== "change") continue;
    const written = await executeQuery(tx, row.outcome === "add" ? INSERT[plan.kind] : UPDATE[plan.kind], params(plan.kind, row, by, note));
    if (written.length !== 1) throw new MyobControlsError(409, `Row ${row.line} changed in Floorplan since your preview. Preview again.`);
  }
}
