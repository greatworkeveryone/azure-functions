// Where a Floorplan record goes in MYOB, from the CFO's confirmed mappings
// (migration 125): building → company file, contractor → supplier card,
// charge code → account, and the tax code (the account's, else the
// supplier's). Nothing is guessed: each missing piece is a plain reason the
// proposal is refused with.

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery } from "../db";
import { isMyobFileMode, type MyobFileMode } from "../myob-company-files-store";
import type { SubjectFacts } from "./subjects";

export interface ResolvedMapping {
  account: { label: string; uid: string };
  companyFile: { id: string; mode: MyobFileMode; name: string };
  supplier: { name: string; uid: string };
  taxCode: { code: string; uid: string };
}

export type MappingResult = { ok: true; value: ResolvedMapping } | { ok: false; reasons: string[] };

const p = (name: string, type: (typeof TYPES)[keyof typeof TYPES], value: unknown) => ({ name, type, value });

export async function resolveMapping(connection: Connection, facts: SubjectFacts): Promise<MappingResult> {
  const files = await executeQuery(
    connection,
    `SELECT b.CompanyFileId, f.Name, f.Mode FROM dbo.BuildingCompanyFile b
       JOIN dbo.MyobCompanyFiles f ON f.CompanyFileId = b.CompanyFileId
      WHERE b.BuildingID = @BuildingID`,
    [p("BuildingID", TYPES.Int, facts.buildingId)],
  );
  if (!files[0]) return { ok: false, reasons: [`Building ${facts.buildingId} isn't mapped to a MYOB company file. Ask Johanne to map it.`] };
  const fileId = String(files[0].CompanyFileId).toLowerCase();
  const mode = isMyobFileMode(files[0].Mode) ? files[0].Mode : "off";
  const fileName = (files[0].Name as string | null) ?? `Company file ${fileId.slice(0, 8)}`;

  const reasons: string[] = [];
  const supplierRows = facts.contractorId
    ? await executeQuery(
        connection,
        `SELECT SupplierUid, SupplierName, TaxCodeUid, TaxCode FROM dbo.ContractorMyobSupplier
          WHERE CompanyFileId = @CompanyFileId AND ContractorID = @ContractorID`,
        [p("CompanyFileId", TYPES.NVarChar, fileId), p("ContractorID", TYPES.Int, facts.contractorId)],
      )
    : [];
  const supplier = supplierRows[0];
  if (!supplier) reasons.push(`Ask Johanne to add ${facts.contractorName ?? "this contractor"} to the supplier export`);

  const accountRows = facts.chargeCode
    ? await executeQuery(
        connection,
        `SELECT AccountUid, AccountDisplayId, AccountName, TaxCodeUid, TaxCode FROM dbo.ChargeCodeAccount
          WHERE CompanyFileId = @CompanyFileId AND ChargeCode = @ChargeCode`,
        [p("CompanyFileId", TYPES.NVarChar, fileId), p("ChargeCode", TYPES.NVarChar, facts.chargeCode)],
      )
    : [];
  const account = accountRows[0];
  if (!facts.chargeCode) reasons.push("Choose a charge code on the purchase order first");
  else if (!account) reasons.push(`Ask Johanne to map charge code ${facts.chargeCode} to a MYOB account in ${fileName}`);

  const taxUid = (account?.TaxCodeUid as string | null) ?? (supplier?.TaxCodeUid as string | null) ?? null;
  const taxCode = (account?.TaxCodeUid ? account?.TaxCode : supplier?.TaxCode) as string | null | undefined;
  if (supplier && account && !taxUid) reasons.push(`Ask Johanne for ${String(supplier.SupplierName)}'s default tax code`);

  if (reasons.length > 0 || !supplier || !account || !taxUid) return { ok: false, reasons };
  const label = [account.AccountDisplayId, account.AccountName].filter(Boolean).join(" ") || String(account.AccountUid);
  return {
    ok: true,
    value: {
      account: { label, uid: String(account.AccountUid) },
      companyFile: { id: fileId, mode, name: fileName },
      supplier: { name: String(supplier.SupplierName), uid: String(supplier.SupplierUid) },
      taxCode: { code: taxCode ?? "tax code", uid: taxUid },
    },
  };
}
