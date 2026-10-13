// dbo.EscalationPolicies, cached for five minutes (PLAN §3.7). Admins edit the
// table, not the code, so a change takes effect within one cache lifetime on
// every instance.

import type { Connection } from "tedious";
import { executeQuery } from "../db";
import type { AutoReescalate, EscalationKind, EscalationPolicy, LadderEntry, LadderToken, PolicyClock } from "./types";

export const POLICY_CACHE_TTL_MS = 5 * 60_000;

const POLICY_COLUMNS = "PolicyKey, Kind, Urgent, Clock, Ladder, AutoReescalate, Active, UpdatedAt, UpdatedBy";

const KINDS: readonly string[] = ["attention", "authority"];
const CLOCKS: readonly string[] = ["business", "wall"];
const AUTO: readonly string[] = ["yes", "reminder", "nudge", "no"];
const TOKENS: readonly string[] = ["raiser_manager", "authority_route"];

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

/** Ladder JSON -> entries. Each entry names exactly one of role, token or
 *  userTarget, and slaHours is a number of zero or more, or absent. */
export function parseLadder(json: string): LadderEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new PolicyError("Ladder is not valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new PolicyError("Ladder must be a non-empty array");

  return parsed.map((raw, index): LadderEntry => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new PolicyError(`Ladder level ${index + 1} must be an object`);
    }
    const entry = raw as Record<string, unknown>;
    const named = ["role", "token", "userTarget"].filter((key) => entry[key] !== undefined && entry[key] !== null && entry[key] !== false);
    if (named.length !== 1) {
      throw new PolicyError(`Ladder level ${index + 1} needs exactly one of role, token or userTarget`);
    }
    const result: LadderEntry = {};
    if (typeof entry.role === "string" && entry.role.trim()) {
      result.role = entry.role.trim().toLowerCase();
    } else if (typeof entry.token === "string" && TOKENS.includes(entry.token)) {
      result.token = entry.token as LadderToken;
    } else if (entry.userTarget === true) {
      result.userTarget = true;
    } else {
      throw new PolicyError(`Ladder level ${index + 1} has an unknown role, token or userTarget`);
    }
    if (entry.slaHours !== undefined && entry.slaHours !== null) {
      if (typeof entry.slaHours !== "number" || !Number.isFinite(entry.slaHours) || entry.slaHours < 0) {
        throw new PolicyError(`Ladder level ${index + 1} has a bad slaHours`);
      }
      result.slaHours = entry.slaHours;
    }
    return result;
  });
}

/** One database row -> a policy. Throws PolicyError for a row an admin broke. */
export function parsePolicyRow(row: Record<string, unknown>): EscalationPolicy {
  const key = String(row.PolicyKey ?? "");
  const kind = String(row.Kind ?? "");
  const clock = String(row.Clock ?? "");
  const auto = String(row.AutoReescalate ?? "");
  if (!key) throw new PolicyError("A policy has no key");
  if (!KINDS.includes(kind)) throw new PolicyError(`${key}: unknown kind "${kind}"`);
  if (!CLOCKS.includes(clock)) throw new PolicyError(`${key}: unknown clock "${clock}"`);
  if (!AUTO.includes(auto)) throw new PolicyError(`${key}: unknown AutoReescalate "${auto}"`);
  return {
    active: Boolean(row.Active),
    autoReescalate: auto as AutoReescalate,
    clock: clock as PolicyClock,
    kind: kind as EscalationKind,
    ladder: parseLadder(String(row.Ladder ?? "")),
    policyKey: key,
    updatedAt: row.UpdatedAt instanceof Date ? row.UpdatedAt : null,
    updatedBy: typeof row.UpdatedBy === "string" ? row.UpdatedBy : null,
    urgent: Boolean(row.Urgent),
  };
}

interface PolicyCache {
  invalid: string[];
  loadedAt: number;
  policies: Map<string, EscalationPolicy>;
}

let cache: PolicyCache | null = null;

export function invalidatePolicyCache(): void {
  cache = null;
}

async function load(connection: Connection, nowMs: number): Promise<PolicyCache> {
  const rows = await executeQuery(connection, `SELECT ${POLICY_COLUMNS} FROM dbo.EscalationPolicies`);
  const policies = new Map<string, EscalationPolicy>();
  const invalid: string[] = [];
  for (const row of rows) {
    try {
      const policy = parsePolicyRow(row);
      policies.set(policy.policyKey, policy);
    } catch (error) {
      // A broken row is left out, so raising it fails loudly ("unknown policy")
      // while every other policy keeps working.
      invalid.push(error instanceof Error ? error.message : String(error));
      console.warn(`[escalation] ignoring a policy row: ${invalid[invalid.length - 1]}`);
    }
  }
  return { invalid, loadedAt: nowMs, policies };
}

/** Every policy, from the cache while it is under five minutes old. If the
 *  reload fails the stale copy is served, so a database blip doesn't stop
 *  escalations that can still be written. */
export async function loadPolicies(connection: Connection, nowMs: number = Date.now()): Promise<Map<string, EscalationPolicy>> {
  if (cache && nowMs - cache.loadedAt < POLICY_CACHE_TTL_MS) return cache.policies;
  try {
    cache = await load(connection, nowMs);
  } catch (error) {
    if (!cache) throw error;
    console.warn(`[escalation] could not reload policies, using the cached copy: ${error instanceof Error ? error.message : String(error)}`);
  }
  return cache.policies;
}

export async function getPolicy(connection: Connection, policyKey: string, nowMs: number = Date.now()): Promise<EscalationPolicy | null> {
  return (await loadPolicies(connection, nowMs)).get(policyKey) ?? null;
}

/** Policy rows ignored at the last load because they were not valid. */
export function invalidPolicyMessages(): readonly string[] {
  return cache?.invalid ?? [];
}
