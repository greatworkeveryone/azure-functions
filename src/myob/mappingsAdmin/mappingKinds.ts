// The three mappings Johanne imports (plan M2), one CSV each:
//   suppliers  contractor → MYOB supplier card, per company file
//   accounts   Floorplan charge code → MYOB account (and its tax code), per file
//   buildings  building → the company file its records go to
// Each says which columns it needs, how a row reads, and why one is skipped.
// Values are what the migration-125 tables hold; UIDs are lower-cased.

import { CHARGE_CODES, isChargeCode } from "../../reference-codes";

export type MappingKind = "accounts" | "buildings" | "suppliers";
export const MAPPING_KINDS: readonly MappingKind[] = ["suppliers", "accounts", "buildings"];
export const isMappingKind = (value: unknown): value is MappingKind => typeof value === "string" && (MAPPING_KINDS as readonly string[]).includes(value);

export type MappingValues = Record<string, string | null>;

export interface ExistingMapping {
  rowVersion: string;
  values: MappingValues;
}

export interface MappingRefs {
  buildings: Map<number, string>;
  contractors: Map<number, { abn: string | null; name: string }>;
  /** The mappings in Floorplan now, by key. */
  existing: Map<string, ExistingMapping>;
  /** Registered company files, id → name. */
  files: Map<string, string>;
}

export type ReadRow =
  | { file: string; key: string; ok: true; subject: string; target: string; values: MappingValues }
  | { ok: false; reason: string };

export interface KindDefinition {
  columns: string[];
  fields: Record<string, string>;
  label: string;
  read: (cells: Record<string, string>, refs: MappingRefs) => ReadRow;
  required: string[];
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXAMPLE_UID = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const text = (value: string | undefined) => (value?.trim() ? value.trim() : null);
const skip = (reason: string): ReadRow => ({ ok: false, reason });

function registeredFile(cells: Record<string, string>, refs: MappingRefs): string | ReadRow {
  const file = (cells.company_file_id ?? "").trim().toLowerCase();
  if (!GUID.test(file)) return skip(`company_file_id must be a MYOB company file id (like ${EXAMPLE_UID})`);
  if (!refs.files.has(file)) return skip(`company file ${file} isn't registered with Floorplan (Admin → MYOB → Entities)`);
  return file;
}

function uid(cells: Record<string, string>, column: string, required: boolean): string | null | ReadRow {
  const value = text(cells[column]);
  if (!value) return required ? skip(`${column} is empty`) : null;
  return GUID.test(value) ? value.toLowerCase() : skip(`${column} must be a MYOB UID (like ${EXAMPLE_UID})`);
}

function bounded(cells: Record<string, string>, column: string, max: number, required = false): string | null | ReadRow {
  const value = text(cells[column]);
  if (!value) return required ? skip(`${column} is empty`) : null;
  return value.length <= max ? value : skip(`${column} is longer than ${max} characters`);
}

const isSkip = (value: unknown): value is ReadRow => typeof value === "object" && value !== null && "ok" in value;
const wholeNumber = (value: string | undefined) => (/^\d{1,9}$/.test((value ?? "").trim()) ? Number(value) : null);

const suppliers: KindDefinition = {
  columns: ["company_file_id", "contractor_id", "contractor_name", "supplier_uid", "supplier_name", "abn", "tax_code_uid", "tax_code"],
  fields: { abn: "ABN", supplierName: "Supplier name", supplierUid: "Supplier UID", taxCode: "Tax code", taxCodeUid: "Tax code UID" },
  label: "supplier mappings",
  read(cells, refs) {
    const id = wholeNumber(cells.contractor_id);
    const contractor = id === null ? null : refs.contractors.get(id);
    const subject = id === null ? "this row" : `contractor #${id}${contractor ? ` ${contractor.name}` : ""}`;
    const file = registeredFile(cells, refs);
    if (isSkip(file)) return file;
    if (id === null) return skip("contractor_id must be a Floorplan contractor number");
    if (!contractor) return skip(`Floorplan has no contractor #${id}`);
    const supplierUid = uid(cells, "supplier_uid", true);
    const supplierName = bounded(cells, "supplier_name", 200, true);
    const taxCodeUid = uid(cells, "tax_code_uid", false);
    const taxCode = bounded(cells, "tax_code", 10);
    const abnText = (cells.abn ?? "").replace(/\s+/g, "");
    if (abnText && !/^\d{11}$/.test(abnText)) return skip("abn must be 11 digits");
    for (const value of [supplierUid, supplierName, taxCodeUid, taxCode]) if (isSkip(value)) return value;
    const values = { abn: abnText || null, supplierName: supplierName as string, supplierUid: supplierUid as string, taxCode: taxCode as string | null, taxCodeUid: taxCodeUid as string | null };
    return { file, key: `${file}|${id}`, ok: true, subject, target: `MYOB supplier ${values.supplierName}`, values };
  },
  required: ["company_file_id", "contractor_id", "supplier_uid", "supplier_name"],
};

const accounts: KindDefinition = {
  columns: ["company_file_id", "charge_code", "account_uid", "account_display_id", "account_name", "tax_code_uid", "tax_code"],
  fields: { accountDisplayId: "Account number", accountName: "Account name", accountUid: "Account UID", taxCode: "Tax code", taxCodeUid: "Tax code UID" },
  label: "account mappings",
  read(cells, refs) {
    const code = (cells.charge_code ?? "").trim().toLowerCase();
    const file = registeredFile(cells, refs);
    if (isSkip(file)) return file;
    if (!isChargeCode(code)) return skip(`${code || "(empty)"} isn't one of Floorplan's charge codes`);
    const accountUid = uid(cells, "account_uid", true);
    const accountDisplayId = bounded(cells, "account_display_id", 20);
    const accountName = bounded(cells, "account_name", 200);
    const taxCodeUid = uid(cells, "tax_code_uid", false);
    const taxCode = bounded(cells, "tax_code", 10);
    for (const value of [accountUid, accountDisplayId, accountName, taxCodeUid, taxCode]) if (isSkip(value)) return value;
    const values = { accountDisplayId, accountName, accountUid, taxCode, taxCodeUid } as MappingValues;
    const account = [values.accountDisplayId, values.accountName].filter(Boolean).join(" ") || String(values.accountUid);
    return { file, key: `${file}|${code}`, ok: true, subject: `charge code ${code} (${CHARGE_CODES[code]})`, target: `MYOB account ${account}`, values };
  },
  required: ["company_file_id", "charge_code", "account_uid"],
};

const buildings: KindDefinition = {
  columns: ["building_id", "building_name", "company_file_id"],
  fields: { companyFileId: "Company file" },
  label: "building mappings",
  read(cells, refs) {
    const id = wholeNumber(cells.building_id);
    if (id === null) return skip("building_id must be a Floorplan building number");
    const name = refs.buildings.get(id);
    if (name === undefined) return skip(`Floorplan has no building #${id}`);
    const file = registeredFile(cells, refs);
    if (isSkip(file)) return file;
    return { file, key: String(id), ok: true, subject: `building #${id} ${name}`, target: refs.files.get(file) ?? file, values: { companyFileId: file } };
  },
  required: ["building_id", "company_file_id"],
};

export const KINDS: Record<MappingKind, KindDefinition> = { accounts, buildings, suppliers };
