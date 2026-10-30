// SQL for tenancy contacts and links. Every statement is parameterised; nothing here deletes.

import { TYPES, type Connection } from "tedious";
import { executeQuery, type SqlParam, type SqlRow } from "../db";
import type { ContactApi, LinkApi, LinkStatus, TenancyState } from "./types";

const iso = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : null);
export const versionText = (value: unknown): string => (Buffer.isBuffer(value) ? value.toString("base64") : "");

/** A stale or malformed version never matches a row, which is what returns 409. */
export function versionBuffer(text: unknown): Buffer | null {
  if (typeof text !== "string" || text.length === 0) return null;
  const buf = Buffer.from(text, "base64");
  return buf.length === 8 ? buf : null;
}

export function linkStatus(row: { ExpiresAt?: unknown; RevokedAt?: unknown } | null, now: Date): LinkStatus {
  if (!row || !(row.ExpiresAt instanceof Date)) return "none";
  if (row.RevokedAt instanceof Date) return "revoked";
  return row.ExpiresAt.getTime() <= now.getTime() ? "expired" : "active";
}

const CONTACTS_SQL = `SELECT c.ContactId, c.TenantId, c.Name, c.Email, c.Phone, c.ReportsIssues, c.AuthorisedForCosts, c.IsEscalation,
       c.ArchivedAt, c.ArchivedBy, c.RowVersion,
       l.LinkId, l.IssuedAt, l.ExpiresAt, l.RevokedAt, l.RevokeReason, l.LastUsedAt, l.UseCount
  FROM dbo.TenancyContacts c
  OUTER APPLY (SELECT TOP (1) x.* FROM dbo.TenantLinks x WHERE x.ContactId = c.ContactId AND x.ActivatedAt IS NOT NULL ORDER BY x.LinkId DESC) l
 WHERE c.TenantId = @TenantId
 ORDER BY CASE WHEN c.ArchivedAt IS NULL THEN 0 ELSE 1 END, c.ContactId`;

export function contactFromRow(row: SqlRow, now: Date): ContactApi {
  const status = linkStatus(row.LinkId == null ? null : (row as { ExpiresAt?: unknown; RevokedAt?: unknown }), now);
  const link: LinkApi | null =
    row.LinkId == null
      ? null
      : {
          expiresAt: iso(row.ExpiresAt) ?? "",
          issuedAt: iso(row.IssuedAt) ?? "",
          lastUsedAt: iso(row.LastUsedAt),
          linkId: Number(row.LinkId),
          revokeReason: row.RevokeReason == null ? null : String(row.RevokeReason),
          revokedAt: iso(row.RevokedAt),
          status,
          useCount: Number(row.UseCount ?? 0),
        };
  return {
    archivedAt: iso(row.ArchivedAt),
    archivedBy: row.ArchivedBy == null ? null : String(row.ArchivedBy),
    authorisedForCosts: row.AuthorisedForCosts === true,
    contactId: Number(row.ContactId),
    email: row.Email == null ? null : String(row.Email),
    escalation: row.IsEscalation === true,
    link,
    linkStatus: status,
    name: String(row.Name ?? ""),
    phone: row.Phone == null ? null : String(row.Phone),
    reportsIssues: row.ReportsIssues === true,
    rowVersion: versionText(row.RowVersion),
    tenantId: Number(row.TenantId),
  };
}

const p = (name: string, type: SqlParam["type"], value: unknown): SqlParam => ({ name, type, value });

export async function listContacts(connection: Connection, tenantId: number, now: Date = new Date()): Promise<ContactApi[]> {
  const rows = await executeQuery(connection, CONTACTS_SQL, [p("TenantId", TYPES.Int, tenantId)]);
  return rows.map((row) => contactFromRow(row, now));
}

const CONTACT_COLUMNS = `SELECT c.ContactId, c.TenantId, c.Name, c.Email, c.Phone, c.ReportsIssues, c.AuthorisedForCosts, c.IsEscalation,
       c.ArchivedAt, c.ArchivedBy, c.RowVersion, CAST(NULL AS INT) AS LinkId`;
const CONTACT_WHERE = `WHERE c.ContactId = @ContactId AND c.TenantId = @TenantId`;
const CONTACT_SQL = `${CONTACT_COLUMNS} FROM dbo.TenancyContacts c ${CONTACT_WHERE}`;
const CONTACT_LOCKED_SQL = `${CONTACT_COLUMNS} FROM dbo.TenancyContacts c WITH (UPDLOCK, HOLDLOCK) ${CONTACT_WHERE}`;

export async function readContact(connection: Connection, tenantId: number, contactId: number, lock = false): Promise<ContactApi | null> {
  const [row] = await executeQuery(connection, lock ? CONTACT_LOCKED_SQL : CONTACT_SQL, [p("ContactId", TYPES.Int, contactId), p("TenantId", TYPES.Int, tenantId)]);
  return row ? contactFromRow(row, new Date()) : null;
}

/** The tenancy row, locked for the caller's transaction. */
export async function readTenancy(connection: Connection, tenantId: number): Promise<TenancyState | null> {
  const [row] = await executeQuery(
    connection,
    `SELECT TenantId, BuildingId, LegalName, EmailOnly, IsTest, ArchivedAt, RowVersion
       FROM dbo.Tenants WITH (UPDLOCK, HOLDLOCK) WHERE TenantId = @TenantId`,
    [p("TenantId", TYPES.Int, tenantId)],
  );
  if (!row) return null;
  return {
    archivedAt: (row.ArchivedAt as Date | null) ?? null,
    buildingId: row.BuildingId == null ? null : Number(row.BuildingId),
    emailOnly: row.EmailOnly === true,
    isTest: row.IsTest === true,
    legalName: String(row.LegalName ?? `Tenancy #${tenantId}`),
    rowVersion: row.RowVersion as Buffer,
    tenantId: Number(row.TenantId),
  };
}

/** Seeds the primary contact once: only for a tenancy that has never had a contact (archived ones count). */
export async function seedIfNoContacts(connection: Connection, tenantId: number, by: string): Promise<void> {
  await executeQuery(
    connection,
    `INSERT INTO dbo.TenancyContacts (TenantId, Name, Email, Phone, ReportsIssues, SeededFromPrimary, CreatedBy, UpdatedBy)
     SELECT t.TenantId, LTRIM(RTRIM(t.PrimaryContactName)), NULLIF(LTRIM(RTRIM(t.PrimaryContactEmail)), N''),
            NULLIF(LTRIM(RTRIM(t.PrimaryContactPhone)), N''), 1, 1, @By, @By
       FROM dbo.Tenants t
      WHERE t.TenantId = @TenantId AND NULLIF(LTRIM(RTRIM(t.PrimaryContactName)), N'') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM dbo.TenancyContacts c WHERE c.TenantId = t.TenantId)`,
    [p("TenantId", TYPES.Int, tenantId), p("By", TYPES.NVarChar, by)],
  );
}

export interface ContactFields {
  authorisedForCosts: boolean;
  email: string | null;
  escalation: boolean;
  name: string;
  phone: string | null;
  reportsIssues: boolean;
}

const fieldParams = (f: ContactFields, by: string) => [
  p("Name", TYPES.NVarChar, f.name),
  p("Email", TYPES.NVarChar, f.email),
  p("Phone", TYPES.NVarChar, f.phone),
  p("Reports", TYPES.Bit, f.reportsIssues),
  p("Costs", TYPES.Bit, f.authorisedForCosts),
  p("Escalation", TYPES.Bit, f.escalation),
  p("By", TYPES.NVarChar, by),
];

export async function insertContact(connection: Connection, tenantId: number, f: ContactFields, by: string): Promise<number> {
  const [row] = await executeQuery(
    connection,
    `INSERT INTO dbo.TenancyContacts (TenantId, Name, Email, Phone, ReportsIssues, AuthorisedForCosts, IsEscalation, CreatedBy, UpdatedBy)
     OUTPUT INSERTED.ContactId VALUES (@TenantId, @Name, @Email, @Phone, @Reports, @Costs, @Escalation, @By, @By)`,
    [p("TenantId", TYPES.Int, tenantId), ...fieldParams(f, by)],
  );
  return Number(row?.ContactId);
}

/** False when the version is stale (or the contact is gone): the caller answers 409. */
export async function updateContact(connection: Connection, tenantId: number, contactId: number, f: ContactFields, version: Buffer, by: string): Promise<boolean> {
  const rows = await executeQuery(
    connection,
    `UPDATE dbo.TenancyContacts SET Name = @Name, Email = @Email, Phone = @Phone, ReportsIssues = @Reports, AuthorisedForCosts = @Costs,
            IsEscalation = @Escalation, UpdatedAt = SYSUTCDATETIME(), UpdatedBy = @By
     OUTPUT INSERTED.ContactId
      WHERE ContactId = @ContactId AND TenantId = @TenantId AND RowVersion = @Version AND ArchivedAt IS NULL`,
    [p("ContactId", TYPES.Int, contactId), p("TenantId", TYPES.Int, tenantId), p("Version", TYPES.Binary, version), ...fieldParams(f, by)],
  );
  return rows.length > 0;
}

export async function setContactArchived(connection: Connection, tenantId: number, contactId: number, archived: boolean, version: Buffer, by: string): Promise<boolean> {
  const rows = await executeQuery(
    connection,
    `UPDATE dbo.TenancyContacts SET ArchivedAt = CASE WHEN @Archived = 1 THEN SYSUTCDATETIME() ELSE NULL END,
            ArchivedBy = CASE WHEN @Archived = 1 THEN @By ELSE NULL END, UpdatedAt = SYSUTCDATETIME(), UpdatedBy = @By
     OUTPUT INSERTED.ContactId
      WHERE ContactId = @ContactId AND TenantId = @TenantId AND RowVersion = @Version`,
    [p("ContactId", TYPES.Int, contactId), p("TenantId", TYPES.Int, tenantId), p("Version", TYPES.Binary, version), p("By", TYPES.NVarChar, by), p("Archived", TYPES.Bit, archived)],
  );
  return rows.length > 0;
}

export async function setEmailOnlyFlag(connection: Connection, tenantId: number, emailOnly: boolean, version: Buffer): Promise<boolean> {
  const rows = await executeQuery(
    connection,
    `UPDATE dbo.Tenants SET EmailOnly = @Flag OUTPUT INSERTED.TenantId WHERE TenantId = @TenantId AND RowVersion = @Version`,
    [p("TenantId", TYPES.Int, tenantId), p("Flag", TYPES.Bit, emailOnly), p("Version", TYPES.Binary, version)],
  );
  return rows.length > 0;
}

// ── Links ────────────────────────────────────────────────────────────────────

/** A new link, not yet usable: it works only once the email carrying it has been accepted (activateLink). */
export async function insertPendingLink(connection: Connection, c: { contactId: number; expiresAt: Date; hash: Buffer; issuedBy: string; tenantId: number }): Promise<number> {
  const [row] = await executeQuery(
    connection,
    `INSERT INTO dbo.TenantLinks (ContactId, TenantId, TokenHash, ExpiresAt, IssuedBy) OUTPUT INSERTED.LinkId
     VALUES (@ContactId, @TenantId, @Hash, @ExpiresAt, @By)`,
    [p("ContactId", TYPES.Int, c.contactId), p("TenantId", TYPES.Int, c.tenantId), p("Hash", TYPES.Binary, c.hash), p("ExpiresAt", TYPES.DateTime2, c.expiresAt), p("By", TYPES.NVarChar, c.issuedBy)],
  );
  return Number(row?.LinkId);
}

/**
 * Live (delivered, unrevoked) link ids of a contact, other than `except`. With `includePending`, links whose
 * email is still being sent are included too: a revoke must catch them, or an issue in flight would switch
 * its link on after the revoke (activateLink skips a revoked link).
 */
export async function liveLinkIds(connection: Connection, contactId: number, except = 0, includePending = false): Promise<{ expiresAt: Date; linkId: number }[]> {
  const rows = await executeQuery(
    connection,
    `SELECT LinkId, ExpiresAt FROM dbo.TenantLinks WITH (UPDLOCK, HOLDLOCK)
      WHERE ContactId = @ContactId AND (ActivatedAt IS NOT NULL OR @Pending = 1) AND RevokedAt IS NULL AND LinkId <> @Except`,
    [p("ContactId", TYPES.Int, contactId), p("Except", TYPES.Int, except), p("Pending", TYPES.Bit, includePending)],
  );
  return rows.map((r) => ({ expiresAt: r.ExpiresAt as Date, linkId: Number(r.LinkId) }));
}

export async function activateLink(connection: Connection, linkId: number): Promise<void> {
  await executeQuery(connection, `UPDATE dbo.TenantLinks SET ActivatedAt = SYSUTCDATETIME() WHERE LinkId = @LinkId AND ActivatedAt IS NULL AND RevokedAt IS NULL`, [p("LinkId", TYPES.Int, linkId)]);
}

/** Revokes one link; returns false when it was already revoked. */
export async function revokeLink(connection: Connection, linkId: number, by: string, reason: string): Promise<boolean> {
  const rows = await executeQuery(
    connection,
    `UPDATE dbo.TenantLinks SET RevokedAt = SYSUTCDATETIME(), RevokedBy = @By, RevokeReason = @Reason OUTPUT INSERTED.LinkId WHERE LinkId = @LinkId AND RevokedAt IS NULL`,
    [p("LinkId", TYPES.Int, linkId), p("By", TYPES.NVarChar, by), p("Reason", TYPES.NVarChar, reason)],
  );
  return rows.length > 0;
}

/** Every unrevoked link of every contact of a tenancy, pending ones included (for email only). */
export async function liveLinksOfTenancy(connection: Connection, tenantId: number): Promise<{ contactId: number; linkId: number }[]> {
  const rows = await executeQuery(
    connection,
    `SELECT LinkId, ContactId FROM dbo.TenantLinks WITH (UPDLOCK, HOLDLOCK) WHERE TenantId = @TenantId AND RevokedAt IS NULL`,
    [p("TenantId", TYPES.Int, tenantId)],
  );
  return rows.map((r) => ({ contactId: Number(r.ContactId), linkId: Number(r.LinkId) }));
}
