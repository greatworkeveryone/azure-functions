// dbo.MyobCompanyFiles (migration 124): the MYOB company files ("entities")
// Floorplan knows, and the mode the CFO has set for each (decision 14):
//   off    Floorplan makes no call to the file at all (the default)
//   read   reads only: quotes, orders and bills
//   write  reads, and the writes her controls switch on
// A file that isn't in the table is treated exactly like one set to off.

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery, type SqlRow } from "./db";

export const MYOB_FILE_MODES = ["off", "read", "write"] as const;
export type MyobFileMode = (typeof MYOB_FILE_MODES)[number];

export function isMyobFileMode(value: unknown): value is MyobFileMode {
  return typeof value === "string" && (MYOB_FILE_MODES as readonly string[]).includes(value);
}

export interface CompanyFileRow {
  companyFileId: string;
  discoveredAt: string | null;
  isDemonstration: boolean;
  mode: MyobFileMode;
  name: string | null;
  note: string | null;
  registeredAt: string | null;
  registeredBy: string | null;
  /** base64 ROWVERSION; what a change must send back. */
  rowVersion: string;
  updatedAt: string | null;
  updatedBy: string | null;
  uri: string | null;
}

export const FILE_COLUMNS =
  "CompanyFileId, Name, Uri, Mode, IsDemonstration, DiscoveredAt, RegisteredBy, RegisteredAt, Note, UpdatedBy, UpdatedAt, RowVersion";
export const INSERTED_FILE_COLUMNS = FILE_COLUMNS.split(", ")
  .map((column) => `inserted.${column}`)
  .join(", ");

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : null);

export function toCompanyFileRow(raw: SqlRow): CompanyFileRow {
  const mode = isMyobFileMode(raw.Mode) ? raw.Mode : "off";
  return {
    companyFileId: String(raw.CompanyFileId ?? "").toLowerCase(),
    discoveredAt: iso(raw.DiscoveredAt),
    isDemonstration: Boolean(raw.IsDemonstration),
    mode,
    name: (raw.Name as string | null) ?? null,
    note: (raw.Note as string | null) ?? null,
    registeredAt: iso(raw.RegisteredAt),
    registeredBy: (raw.RegisteredBy as string | null) ?? null,
    rowVersion: Buffer.isBuffer(raw.RowVersion) ? raw.RowVersion.toString("base64") : "",
    updatedAt: iso(raw.UpdatedAt),
    updatedBy: (raw.UpdatedBy as string | null) ?? null,
    uri: (raw.Uri as string | null) ?? null,
  };
}

export async function readCompanyFiles(connection: Connection): Promise<CompanyFileRow[]> {
  const rows = await executeQuery(connection, `SELECT ${FILE_COLUMNS} FROM dbo.MyobCompanyFiles`);
  return rows.map(toCompanyFileRow);
}

/** The file's mode; "off" for a file that isn't registered, or a value the code doesn't know. */
export async function readFileMode(connection: Connection, companyFileId: string): Promise<MyobFileMode> {
  const rows = await executeQuery(connection, `SELECT Mode FROM dbo.MyobCompanyFiles WHERE CompanyFileId = @CompanyFileId`, [
    { name: "CompanyFileId", type: TYPES.NVarChar, value: companyFileId },
  ]);
  const mode = rows[0]?.Mode;
  return isMyobFileMode(mode) ? mode : "off";
}
