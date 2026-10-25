// Who an approval or escalation email goes to (decision 3, F9): the active
// AppUsers holding the role. An env list stands in only while nobody holds
// it, and that stand-in is reported as system.health so it is not permanent.

import type { Connection } from "tedious";
import { normaliseRole } from "../escalation/roles";
import { listActiveUsers } from "../escalation/store";
import { Sentry } from "../sentry";

export interface RoleRecipients {
  addresses: string[];
  source: "env_fallback" | "roles";
}

function unique(addresses: readonly (string | null)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of addresses) {
    const address = raw?.trim();
    if (!address || seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    result.push(address);
  }
  return result;
}

export function reportSystemHealth(message: string): void {
  console.warn(`[system.health] ${message}`);
  Sentry.captureMessage(`system.health: ${message}`, { level: "warning", tags: { category: "system.health" } });
}

/** Email addresses of the active AppUsers whose role is `role` (case-insensitive). */
export async function activeUsersWithRole(connection: Connection, role: string): Promise<string[]> {
  const wanted = normaliseRole(role);
  const users = await listActiveUsers(connection);
  return unique(users.filter((user) => user.role === wanted).map((user) => user.email));
}

export async function resolveRoleRecipients(
  connection: Connection,
  role: string,
  fallback: readonly string[],
  report: (message: string) => void = reportSystemHealth,
): Promise<RoleRecipients> {
  const fromRoles = await activeUsersWithRole(connection, role);
  if (fromRoles.length > 0) return { addresses: fromRoles, source: "roles" };
  report(`no active ${role} in AppUsers; ${role} emails go to the env fallback list (${fallback.length} address(es))`);
  return { addresses: unique(fallback), source: "env_fallback" };
}
