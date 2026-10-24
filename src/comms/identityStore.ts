// Reply-to identities and personal signature fields: reads and writes (migration 108).
// Identities are archived, never deleted. An edit carries the row's version and a stale
// one is refused (database-safety rule 6).

import { TYPES, type Connection } from "tedious";
import { AppRole } from "../auth";
import { executeQuery, type SqlRow } from "../db";
import { IDENTITY_ROLES, type CommsIdentity } from "./identity";
import type { Signature } from "./signature";

export interface AdminIdentity extends CommsIdentity {
  archivedBy: string | null;
  createdAt: string;
  createdBy: string;
  rowVersion: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface IdentityInput {
  address: string;
  allowedRoles: AppRole[];
  displayName: string;
  isActive: boolean;
  signature: Signature;
  teamLabel: string | null;
}

const COLUMNS = `IdentityId, Address, DisplayName, TeamLabel, AllowedRoles, SignatureLines, SignaturePhone, SignatureEmail, IsActive,
  CONVERT(VARCHAR(16), CAST(Version AS VARBINARY(8)), 2) AS RowVersion, CreatedAt, CreatedBy, UpdatedAt, UpdatedBy, ArchivedAt, ArchivedBy`;

const iso = (value: unknown): string | null => (value ? new Date(value as Date).toISOString() : null);

function parseRoles(json: unknown): AppRole[] {
  try {
    const value = JSON.parse(String(json)) as unknown;
    // A role the table could not have been given (a hand edit) is dropped rather than trusted.
    return Array.isArray(value) ? IDENTITY_ROLES.filter((role) => value.includes(role)) : [];
  } catch {
    return [];
  }
}

function parseLines(json: unknown): string[] {
  try {
    const value = JSON.parse(String(json)) as unknown;
    return Array.isArray(value) ? value.filter((line): line is string => typeof line === "string") : [];
  } catch {
    return [];
  }
}

export function toIdentity(row: SqlRow): AdminIdentity {
  return {
    address: String(row.Address),
    allowedRoles: parseRoles(row.AllowedRoles),
    archivedAt: iso(row.ArchivedAt),
    archivedBy: (row.ArchivedBy as string | null) ?? null,
    createdAt: iso(row.CreatedAt) ?? "",
    createdBy: String(row.CreatedBy),
    displayName: String(row.DisplayName),
    identityId: Number(row.IdentityId),
    isActive: row.IsActive === true || row.IsActive === 1,
    rowVersion: String(row.RowVersion),
    signature: { email: (row.SignatureEmail as string | null) ?? null, lines: parseLines(row.SignatureLines), phone: (row.SignaturePhone as string | null) ?? null },
    teamLabel: (row.TeamLabel as string | null) ?? null,
    updatedAt: iso(row.UpdatedAt),
    updatedBy: (row.UpdatedBy as string | null) ?? null,
  };
}

/** Every identity, live ones first, for the admin page. Archived ones only when asked. */
export async function listIdentities(connection: Connection, includeArchived: boolean): Promise<AdminIdentity[]> {
  const rows = await executeQuery(
    connection,
    `SELECT ${COLUMNS} FROM dbo.CommsIdentities WHERE (ArchivedAt IS NULL OR @IncludeArchived = 1) ORDER BY CASE WHEN ArchivedAt IS NULL THEN 0 ELSE 1 END, DisplayName, IdentityId`,
    [{ name: "IncludeArchived", type: TYPES.Bit, value: includeArchived }],
  );
  return rows.map(toIdentity);
}

export async function readIdentity(connection: Connection, identityId: number): Promise<AdminIdentity | null> {
  const [row] = await executeQuery(connection, `SELECT ${COLUMNS} FROM dbo.CommsIdentities WHERE IdentityId = @Id`, [{ name: "Id", type: TYPES.Int, value: identityId }]);
  return row ? toIdentity(row) : null;
}

function valueParams(input: IdentityInput) {
  return [
    { name: "Address", type: TYPES.NVarChar, value: input.address },
    { name: "DisplayName", type: TYPES.NVarChar, value: input.displayName },
    { name: "TeamLabel", type: TYPES.NVarChar, value: input.teamLabel },
    { name: "AllowedRoles", type: TYPES.NVarChar, value: JSON.stringify(input.allowedRoles) },
    { name: "SignatureLines", type: TYPES.NVarChar, value: JSON.stringify(input.signature.lines) },
    { name: "SignaturePhone", type: TYPES.NVarChar, value: input.signature.phone },
    { name: "SignatureEmail", type: TYPES.NVarChar, value: input.signature.email },
    { name: "IsActive", type: TYPES.Bit, value: input.isActive },
  ];
}

/** True for the duplicate-key error a second live identity on the same address raises. */
export function isDuplicateAddress(error: unknown): boolean {
  const number = (error as { number?: number } | null)?.number;
  return number === 2601 || number === 2627;
}

export async function insertIdentity(connection: Connection, input: IdentityInput, createdBy: string): Promise<number> {
  const [row] = await executeQuery(
    connection,
    `INSERT INTO dbo.CommsIdentities (Address, DisplayName, TeamLabel, AllowedRoles, SignatureLines, SignaturePhone, SignatureEmail, IsActive, CreatedBy)
     OUTPUT INSERTED.IdentityId
     VALUES (@Address, @DisplayName, @TeamLabel, @AllowedRoles, @SignatureLines, @SignaturePhone, @SignatureEmail, @IsActive, @CreatedBy)`,
    [...valueParams(input), { name: "CreatedBy", type: TYPES.NVarChar, value: createdBy }],
  );
  return Number(row.IdentityId);
}

export type WriteResult = "missing" | "ok" | "stale";

/** Saves an edit only if the row is still at `rowVersion` (16 hex characters, as listed). */
export async function updateIdentity(connection: Connection, identityId: number, rowVersion: string, input: IdentityInput, updatedBy: string): Promise<WriteResult> {
  const rows = await executeQuery(
    connection,
    `UPDATE dbo.CommsIdentities SET Address = @Address, DisplayName = @DisplayName, TeamLabel = @TeamLabel, AllowedRoles = @AllowedRoles,
        SignatureLines = @SignatureLines, SignaturePhone = @SignaturePhone, SignatureEmail = @SignatureEmail, IsActive = @IsActive,
        UpdatedAt = SYSUTCDATETIME(), UpdatedBy = @UpdatedBy
      OUTPUT INSERTED.IdentityId
      WHERE IdentityId = @Id AND ArchivedAt IS NULL AND Version = CONVERT(BINARY(8), @RowVersion, 2)`,
    [
      ...valueParams(input),
      { name: "Id", type: TYPES.Int, value: identityId },
      { name: "RowVersion", type: TYPES.VarChar, value: rowVersion },
      { name: "UpdatedBy", type: TYPES.NVarChar, value: updatedBy },
    ],
  );
  if (rows.length === 1) return "ok";
  return (await readIdentity(connection, identityId)) === null ? "missing" : "stale";
}

/** Archives (or restores) an identity; archived ones are never offered. Version-checked like an edit. */
export async function setIdentityArchived(connection: Connection, identityId: number, rowVersion: string, archived: boolean, by: string): Promise<WriteResult> {
  const rows = await executeQuery(
    connection,
    `UPDATE dbo.CommsIdentities SET
        ArchivedAt = CASE WHEN @Archived = 1 THEN SYSUTCDATETIME() ELSE NULL END,
        ArchivedBy = CASE WHEN @Archived = 1 THEN @By ELSE NULL END,
        IsActive = CASE WHEN @Archived = 1 THEN 0 ELSE IsActive END,
        UpdatedAt = SYSUTCDATETIME(), UpdatedBy = @By
      OUTPUT INSERTED.IdentityId
      WHERE IdentityId = @Id AND Version = CONVERT(BINARY(8), @RowVersion, 2)`,
    [
      { name: "Id", type: TYPES.Int, value: identityId },
      { name: "RowVersion", type: TYPES.VarChar, value: rowVersion },
      { name: "Archived", type: TYPES.Bit, value: archived },
      { name: "By", type: TYPES.NVarChar, value: by },
    ],
  );
  if (rows.length === 1) return "ok";
  return (await readIdentity(connection, identityId)) === null ? "missing" : "stale";
}

// ── A person's standard signature fields ─────────────────────────────────────

export interface AppUserRef {
  displayName: string;
  email: string;
  userId: number;
}

export async function findUserByOid(connection: Connection, oid: string): Promise<AppUserRef | null> {
  const [row] = await executeQuery(connection, `SELECT UserID, DisplayName, Email FROM dbo.AppUsers WHERE EntraOid = @Oid AND IsActive = 1`, [
    { name: "Oid", type: TYPES.NVarChar, value: oid },
  ]);
  return row ? { displayName: String(row.DisplayName), email: String(row.Email), userId: Number(row.UserID) } : null;
}

export async function findUserById(connection: Connection, userId: number): Promise<AppUserRef | null> {
  const [row] = await executeQuery(connection, `SELECT UserID, DisplayName, Email FROM dbo.AppUsers WHERE UserID = @Id AND IsActive = 1`, [
    { name: "Id", type: TYPES.Int, value: userId },
  ]);
  return row ? { displayName: String(row.DisplayName), email: String(row.Email), userId: Number(row.UserID) } : null;
}

export interface UserSignatureFields {
  jobTitle: string | null;
  phone: string | null;
  updatedAt: string | null;
}

export async function readUserSignature(connection: Connection, userId: number): Promise<UserSignatureFields> {
  const [row] = await executeQuery(connection, `SELECT JobTitle, Phone, UpdatedAt FROM dbo.UserSignatures WHERE UserId = @Id`, [
    { name: "Id", type: TYPES.Int, value: userId },
  ]);
  return { jobTitle: (row?.JobTitle as string | null) ?? null, phone: (row?.Phone as string | null) ?? null, updatedAt: iso(row?.UpdatedAt) };
}

export async function writeUserSignature(connection: Connection, userId: number, fields: { jobTitle: string | null; phone: string | null }, updatedBy: string): Promise<void> {
  await executeQuery(
    connection,
    `MERGE dbo.UserSignatures AS target
     USING (SELECT @UserId AS UserId) AS source ON target.UserId = source.UserId
     WHEN MATCHED THEN UPDATE SET JobTitle = @JobTitle, Phone = @Phone, UpdatedAt = SYSUTCDATETIME(), UpdatedBy = @UpdatedBy
     WHEN NOT MATCHED THEN INSERT (UserId, JobTitle, Phone, UpdatedBy) VALUES (@UserId, @JobTitle, @Phone, @UpdatedBy);`,
    [
      { name: "UserId", type: TYPES.Int, value: userId },
      { name: "JobTitle", type: TYPES.NVarChar, value: fields.jobTitle },
      { name: "Phone", type: TYPES.NVarChar, value: fields.phone },
      { name: "UpdatedBy", type: TYPES.NVarChar, value: updatedBy },
    ],
  );
}
