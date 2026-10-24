// How much an item matters while its owner is away. Pure.
//
//   high    Critical or High priority, money above the person's team threshold,
//           a lease or rent review deadline, an escalation already at level 2 or
//           above (or marked urgent), an emergency or urgent decision
//   medium  every other decision or piece of work waiting on them
//   low     informational items (a Low priority job)
//
// "Team threshold" is the most a person in the owner's team can approve on their
// own: the highest limit among the roles of their team (teamRolesOf) in the
// ApprovalLimits table. Above it, an item needs someone higher, so it cannot wait.

import type { RoleLimit } from "../approvalAuthority";
import { normaliseRole, teamRolesOf } from "../escalation/roles";
import type { Importance } from "./types";

export interface Rated {
  code: string;
  importance: Importance;
}

export function jobImportance(priority: string | null): Rated {
  if (priority === "Critical" || priority === "High") return { code: "priority", importance: "high" };
  if (priority === "Low") return { code: "priority", importance: "low" };
  return { code: "default", importance: "medium" };
}

export function decisionImportance(tier: string): Rated {
  return tier === "emergency" || tier === "urgent" ? { code: "tier", importance: "high" } : { code: "default", importance: "medium" };
}

const LEASE_DEADLINE_PREFIXES = ["lease.", "rent_review."];

export function escalationImportance(row: { level: number; policyKey: string; urgent: boolean }): Rated {
  const key = row.policyKey.toLowerCase();
  if (LEASE_DEADLINE_PREFIXES.some((prefix) => key.startsWith(prefix))) return { code: "lease_deadline", importance: "high" };
  if (row.level >= 2) return { code: "escalation_level", importance: "high" };
  if (row.urgent) return { code: "urgent", importance: "high" };
  return { code: "default", importance: "medium" };
}

/** The most the owner's team can approve on its own; null when no limit applies (unlimited rows are skipped). */
export function teamMoneyThreshold(ownerRole: string, limits: readonly RoleLimit[]): number | null {
  const team = teamRolesOf(ownerRole) ?? [];
  const roles = new Set([normaliseRole(ownerRole), ...team.map(normaliseRole)]);
  const finite = limits.filter((row) => roles.has(normaliseRole(row.role)) && row.limit !== null && Number.isFinite(row.limit));
  return finite.length === 0 ? null : Math.max(...finite.map((row) => row.limit as number));
}

/** Money above the owner's team threshold is high; an unknown amount is too, as it needs a director. */
export function moneyImportance(amount: number | null, threshold: number | null): Rated {
  if (amount === null || !Number.isFinite(amount)) return { code: "money", importance: "high" };
  if (threshold !== null && amount > threshold) return { code: "money", importance: "high" };
  return { code: "default", importance: "medium" };
}
