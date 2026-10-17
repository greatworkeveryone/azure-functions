// DB-facing half of approval authority: loads the facts the pure core
// (approvalAuthority.ts) decides on. Kept apart so the core stays pure and
// byte-identical to its frontend twin.

import { Connection, TYPES } from "tedious";
import { executeQuery } from "./db";
import { DEFAULT_VARIANCE_FACTS, type VarianceFacts } from "./moneyRules";
import { getCachedApprovalLimits } from "./approval-limits-db";
import { AuthorityFacts, AuthorityInput, AuthorityResult, decideAuthority, toRoleLimits } from "./approvalAuthority";

/**
 * DIRECTOR_APPROVAL_THRESHOLD → AuthorityFacts.directorThreshold. Unset or
 * empty is null: the core then derives the threshold from the limits, as
 * today. Anything that is not a finite number > 0 is also null, plus one
 * console.warn, so a typo falls back to today's rule instead of moving the gate.
 */
export function parseDirectorThreshold(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw.trim());
  if (Number.isFinite(value) && value > 0) return value;
  console.warn(
    `[approvalAuthority] Ignoring DIRECTOR_APPROVAL_THRESHOLD=${JSON.stringify(raw)}: ` +
      "expected a number > 0. Using the highest non-director approval limit instead.",
  );
  return null;
}

/** The calendar date in Darwin (UTC+9:30, no DST) as YYYY-MM-DD. The host clock runs UTC. */
export function darwinToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Australia/Darwin",
    year: "numeric",
  }).formatToParts(now);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Everything decideAuthority / canApprove need to know about one building (null: not known). */
export async function loadApprovalFacts(conn: Connection, buildingId: number | null): Promise<AuthorityFacts> {
  const rows = await getCachedApprovalLimits(conn);
  return {
    directorThreshold: parseDirectorThreshold(process.env.DIRECTOR_APPROVAL_THRESHOLD),
    // WP44 seam: residences need Buildings.PropertyType and BuildingApprovers,
    // looked up by buildingId. Until then every building is a non-residence.
    isResidence: false,
    // Trims and lower-cases RoleName, so the 'Admin' row seeded by migration
    // 026 applies to admin, for its limit as well as for the director gate.
    limits: toRoleLimits(rows),
    residenceApprovers: [],
    residenceDirectorFallback: true,
    today: darwinToday(),
  };
}

/** Loads the facts for input.buildingId and decides the route in one step. */
export async function resolveApprovalAuthority(
  conn: Connection,
  input: AuthorityInput,
): Promise<{ facts: AuthorityFacts; result: AuthorityResult }> {
  const facts = await loadApprovalFacts(conn, input.buildingId);
  return { facts, result: decideAuthority(input, facts) };
}

// ── R13 variance facts and named people (WP43a-2) ────────────────────────────

/** dbo.ApprovalFacts keys (migration 117). */
export const VARIANCE_FACT_KEYS = { capDollars: "po_variance_cap", marginPercent: "po_variance_margin_percent" } as const;

/**
 * The PO variance margin and cap, Admin-editable beside the approval limits. A
 * key with no row (or a value that is not a finite number >= 0) takes the
 * default (10%, $1,000), with a warning. Not cached: read only when an amount
 * has risen past what was approved.
 */
export async function loadVarianceFacts(conn: Connection): Promise<VarianceFacts> {
  const rows = await executeQuery(conn, `SELECT FactKey, FactValue FROM dbo.ApprovalFacts WHERE FactKey IN (@Margin, @Cap)`, [
    { name: "Margin", type: TYPES.NVarChar, value: VARIANCE_FACT_KEYS.marginPercent },
    { name: "Cap", type: TYPES.NVarChar, value: VARIANCE_FACT_KEYS.capDollars },
  ]);
  const read = (key: string, fallback: number): number => {
    const raw = rows.find((row) => row.FactKey === key)?.FactValue;
    const value = raw === null || raw === undefined ? NaN : Number(raw);
    if (Number.isFinite(value) && value >= 0) return value;
    console.warn(`[approvalAuthority] ApprovalFacts ${key} is missing or not a number; using the default ${fallback}`);
    return fallback;
  };
  return {
    capDollars: read(VARIANCE_FACT_KEYS.capDollars, DEFAULT_VARIANCE_FACTS.capDollars),
    marginPercent: read(VARIANCE_FACT_KEYS.marginPercent, DEFAULT_VARIANCE_FACTS.marginPercent),
  };
}

/** A person named on an approval, as AppUsers has them: roles from the table, never the client. */
export interface NamedUser {
  displayName: string;
  email?: string;
  role: string;
  roles: string[];
  userId: number;
}

/** An active AppUsers row by id, or null. */
export async function loadNamedUser(conn: Connection, userId: number): Promise<NamedUser | null> {
  const rows = await executeQuery(
    conn,
    `SELECT UserID, DisplayName, Email, Role FROM dbo.AppUsers WHERE UserID = @UserID AND IsActive = 1`,
    [{ name: "UserID", type: TYPES.Int, value: userId }],
  );
  const row = rows[0];
  if (!row) return null;
  const role = typeof row.Role === "string" ? row.Role.trim().toLowerCase() : "";
  const email = typeof row.Email === "string" && row.Email.trim() ? row.Email.trim() : undefined;
  return {
    displayName: String(row.DisplayName ?? email ?? `User ${userId}`),
    email,
    role,
    roles: role ? [role] : [],
    userId: Number(row.UserID),
  };
}
