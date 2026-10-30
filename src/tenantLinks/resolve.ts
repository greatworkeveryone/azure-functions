// The one door from a personal link to a tenancy (TR2, for TR3's anonymous endpoints).
//
//   resolveTenantLink(token) → { contactId, tenantId, buildingId } | null
//
// null for anything that is not a working link, without saying which: an unknown token, a link
// that was never delivered, revoked, expired, a contact who is archived, an email-only tenancy,
// an archived tenancy. A token is hashed (SHA-256) and looked up by hash; the stored hash is then
// compared again in constant time. A successful resolve counts as a use: it stamps LastUsedAt,
// bumps UseCount and writes a tenancy.link_use ledger row in one transaction (at most once per ten minutes per link), so a use that
// cannot be recorded does not succeed (the error propagates; the caller answers 500, not 200).
// The caller (TR3) owns rate limiting; this module never takes a user token and never trusts
// anything but the token.

import { TYPES, type Connection } from "tedious";
import { beginTransaction, closeConnection, commitTransaction, createServiceRequestConnection, executeQuery, rollbackTransaction } from "../db";
import { record } from "../ledger";
import { hashesEqual, hashToken, isTokenShaped } from "./token";
import type { TenantLinkIdentity } from "./types";

export interface ResolveOptions {
  /** Reuse an open connection (tests, or a caller already holding one). Otherwise a service connection is opened and closed. */
  connection?: Connection;
  now?: Date;
  /** Default true. False checks a link without counting a use. */
  recordUse?: boolean;
}

const LOOKUP_SQL = `SELECT l.LinkId, l.ContactId, l.TenantId, l.TokenHash, l.ExpiresAt, l.ActivatedAt, l.RevokedAt, l.LastUsedAt,
       c.ArchivedAt AS ContactArchivedAt, t.BuildingId, t.EmailOnly, t.ArchivedAt AS TenancyArchivedAt
  FROM dbo.TenantLinks l
  JOIN dbo.TenancyContacts c ON c.ContactId = l.ContactId AND c.TenantId = l.TenantId
  JOIN dbo.Tenants t ON t.TenantId = l.TenantId
 WHERE l.TokenHash = @Hash`;

const USE_SQL = `UPDATE dbo.TenantLinks SET LastUsedAt = SYSUTCDATETIME(), UseCount = UseCount + 1
 OUTPUT INSERTED.UseCount
 WHERE LinkId = @LinkId AND RevokedAt IS NULL`;

/**
 * A use is counted and ledgered at most once per link in this window. Every call still resolves, so a revoked
 * link stops working at once; only the bookkeeping is thinned, so a script or a mail scanner cannot bury a
 * tenancy's history under link_use rows.
 */
export const USE_RECORD_WINDOW_MS = 10 * 60_000;

export async function resolveTenantLink(token: string, options: ResolveOptions = {}): Promise<TenantLinkIdentity | null> {
  if (!isTokenShaped(token)) return null;
  const own = options.connection === undefined;
  const connection = options.connection ?? (await createServiceRequestConnection());
  try {
    return await resolveOn(connection, token, options.now ?? new Date(), options.recordUse !== false);
  } finally {
    if (own) closeConnection(connection);
  }
}

async function resolveOn(connection: Connection, token: string, now: Date, recordUse: boolean): Promise<TenantLinkIdentity | null> {
  const hash = hashToken(token);
  const [row] = await executeQuery(connection, LOOKUP_SQL, [{ name: "Hash", type: TYPES.Binary, value: hash }]);
  if (!row || !Buffer.isBuffer(row.TokenHash) || !hashesEqual(row.TokenHash, hash)) return null;
  if (!(row.ActivatedAt instanceof Date) || row.RevokedAt != null) return null;
  if (!(row.ExpiresAt instanceof Date) || row.ExpiresAt.getTime() <= now.getTime()) return null;
  if (row.ContactArchivedAt != null || row.TenancyArchivedAt != null || row.EmailOnly === true || row.BuildingId == null) return null;
  const identity: TenantLinkIdentity = { buildingId: Number(row.BuildingId), contactId: Number(row.ContactId), tenantId: Number(row.TenantId) };
  if (!recordUse) return identity;
  if (row.LastUsedAt instanceof Date && now.getTime() - row.LastUsedAt.getTime() < USE_RECORD_WINDOW_MS && now.getTime() >= row.LastUsedAt.getTime()) return identity;

  await beginTransaction(connection);
  try {
    const [used] = await executeQuery(connection, USE_SQL, [{ name: "LinkId", type: TYPES.Int, value: Number(row.LinkId) }]);
    if (!used) {
      await rollbackTransaction(connection);
      return null; // revoked between the lookup and the use: it stops working at once
    }
    await record(connection, {
      action: "tenancy.link_use",
      actor: { kind: "system", name: "tenantLinks.resolve" },
      after: { contactId: identity.contactId, linkId: Number(row.LinkId), useCount: Number(used.UseCount) },
      buildingId: identity.buildingId,
      subject: { id: identity.tenantId, type: "tenancy" },
      tenantId: identity.tenantId,
    });
    await commitTransaction(connection);
  } catch (error) {
    await rollbackTransaction(connection).catch(() => undefined);
    throw error;
  }
  return identity;
}
