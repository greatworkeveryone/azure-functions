import { TYPES, type Connection } from "tedious";
import { AppRole } from "../auth";
import { executeQuery } from "../db";
import { parseStoredProfile, type AccessProfile } from "./profile";

// Reads and writes behind the access endpoints (S10). The role lists mirror the
// frontend capabilities viewAccessLog and manageAccessProfiles in command-centre
// src/constants/roles.ts; change them together.

/** The access log: the CFO, and directors and admin through the hierarchy. */
export const ACCESS_VIEW_ROLES = [AppRole.CFO] as const;
/** Editing someone's expected use: admin only. */
export const ACCESS_MANAGE_ROLES = [AppRole.ADMIN] as const;

/** Matches the TOP (500) in listAccessEvents. */
export const MAX_EVENT_ROWS = 500;
export const MAX_DAYS = 30;

export interface AccessEventDto {
  anomaly: string;
  at: string;
  country: string | null;
  detail: Record<string, unknown> | null;
  displayName: string | null;
  id: number;
  kind: string;
  localHour: number | null;
  role: string | null;
  userId: number | null;
}

export interface AccessProfileDto {
  displayName: string;
  email: string | null;
  isDefault: boolean;
  profile: AccessProfile;
  role: string | null;
  userId: number;
}

function parseDetail(text: unknown): Record<string, unknown> | null {
  if (typeof text !== "string" || !text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function listAccessEvents(
  connection: Connection,
  filter: { anomaliesOnly: boolean; days: number; userId: number | null },
): Promise<AccessEventDto[]> {
  const rows = await executeQuery(
    connection,
    `SELECT TOP (500) e.AccessEventId, e.At, e.Role, e.Kind, e.Anomaly, e.Country, e.LocalHour, e.Detail,
            u.UserID, u.DisplayName
       FROM dbo.AccessEvents e
       OUTER APPLY (SELECT TOP 1 UserID, DisplayName FROM dbo.AppUsers WHERE EntraOid = e.Oid) u
      WHERE e.At >= DATEADD(DAY, -@Days, SYSUTCDATETIME())
        AND (@UserId IS NULL OR e.Oid = (SELECT TOP 1 EntraOid FROM dbo.AppUsers WHERE UserID = @UserId))
        AND (@AnomaliesOnly = 0 OR e.Anomaly <> N'none')
      ORDER BY e.At DESC`,
    [
      { name: "Days", type: TYPES.Int, value: filter.days },
      { name: "UserId", type: TYPES.Int, value: filter.userId },
      { name: "AnomaliesOnly", type: TYPES.Bit, value: filter.anomaliesOnly },
    ],
  );
  return rows.map((r) => ({
    anomaly: String(r.Anomaly),
    at: (r.At as Date).toISOString(),
    country: (r.Country as string | null) ?? null,
    detail: parseDetail(r.Detail),
    displayName: (r.DisplayName as string | null) ?? null,
    id: Number(r.AccessEventId),
    kind: String(r.Kind),
    localHour: (r.LocalHour as number | null) ?? null,
    role: (r.Role as string | null) ?? null,
    userId: (r.UserID as number | null) ?? null,
  }));
}

export async function listAccessProfiles(connection: Connection): Promise<AccessProfileDto[]> {
  const rows = await executeQuery(
    connection,
    `SELECT UserID, DisplayName, Email, Role, AccessProfile
       FROM dbo.AppUsers WHERE IsActive = 1 ORDER BY DisplayName`,
  );
  return rows.map((r) => {
    const role = (r.Role as string | null)?.toLowerCase() ?? null;
    const stored = (r.AccessProfile as string | null) ?? null;
    return {
      displayName: String(r.DisplayName ?? ""),
      email: (r.Email as string | null) ?? null,
      isDefault: stored === null,
      profile: parseStoredProfile(stored, role),
      role,
      userId: Number(r.UserID),
    };
  });
}

/** The person's current profile, locked until the caller's transaction ends. */
export async function lockAccessProfile(
  connection: Connection,
  userId: number,
): Promise<{ role: string | null; stored: string | null } | null> {
  const rows = await executeQuery(
    connection,
    `SELECT Role, AccessProfile FROM dbo.AppUsers WITH (UPDLOCK, HOLDLOCK) WHERE UserID = @UserID AND IsActive = 1`,
    [{ name: "UserID", type: TYPES.Int, value: userId }],
  );
  if (rows.length === 0) return null;
  return {
    role: (rows[0].Role as string | null)?.toLowerCase() ?? null,
    stored: (rows[0].AccessProfile as string | null) ?? null,
  };
}

export async function saveAccessProfile(connection: Connection, userId: number, profile: AccessProfile | null): Promise<void> {
  await executeQuery(connection, `UPDATE dbo.AppUsers SET AccessProfile = @AccessProfile WHERE UserID = @UserID`, [
    { name: "AccessProfile", type: TYPES.NVarChar, value: profile ? JSON.stringify(profile) : null },
    { name: "UserID", type: TYPES.Int, value: userId },
  ]);
}

