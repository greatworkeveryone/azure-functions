// A person's standard signature fields (migration 108: UserSignatures, keyed to AppUsers) and the
// AppUsers lookups that find whose they are.

import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../db";

const iso = (value: unknown): string | null => (value ? new Date(value as Date).toISOString() : null);

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
