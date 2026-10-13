// DB-facing half of approval authority: loads the facts the pure core
// (approvalAuthority.ts) decides on. Kept apart so the core stays pure and
// byte-identical to its frontend twin.

import { Connection } from "tedious";
import { getCachedApprovalLimits } from "./approval-limits-db";
import { AuthorityFacts, AuthorityInput, AuthorityResult, decideAuthority } from "./approvalAuthority";

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

/** Everything decideAuthority / canApprove need to know about one building. */
export async function loadApprovalFacts(conn: Connection, buildingId: number): Promise<AuthorityFacts> {
  const rows = await getCachedApprovalLimits(conn);
  return {
    directorThreshold: parseDirectorThreshold(process.env.DIRECTOR_APPROVAL_THRESHOLD),
    // WP44 seam: residences need Buildings.PropertyType and BuildingApprovers,
    // looked up by buildingId. Until then every building is a non-residence.
    isResidence: false,
    // Number() only normalises the DECIMAL; a non-numeric value becomes NaN,
    // which the core treats as no row. Never `?? null`: null means unlimited.
    limits: rows.map((row) => ({
      limit: row.MaxApprovalAmount === null ? null : Number(row.MaxApprovalAmount),
      role: row.RoleName,
    })),
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
