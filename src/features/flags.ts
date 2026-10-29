// Server-side read of dbo.FeatureFlags (first backend use; the frontend reads them via
// getFeatureFlags). Mirrors the frontend's most-permissive-wins resolution but FAILS CLOSED:
// the frontend falls back to its code default so nobody is locked out of the app, while here
// a missing row, unknown value or any error means "off", which is the safe direction for a
// feature that sends something (e.g. teamsAlerts: off means the email goes instead).
//
// Only "enabled" counts; "preview" and "hidden" are off. The whole table (a few dozen rows)
// is cached for 60 s per process, so a toggle reaches every instance within a minute.

import type { Connection } from "tedious";
import { executeQuery } from "../db";

const CACHE_MS = 60_000;

export interface FeatureFlagDeps {
  connection: Connection;
  now?: () => number;
}

interface Cached {
  /** "<featureKey>|<role>" of every enabled row. */
  enabled: ReadonlySet<string>;
  loadedAt: number;
}

let cache: Cached | null = null;

const rowKey = (featureKey: string, role: string): string => `${featureKey}|${role.trim().toLowerCase()}`;

async function loadEnabled(connection: Connection): Promise<ReadonlySet<string>> {
  const rows = await executeQuery(connection, `SELECT FeatureKey, RoleName, Visibility FROM dbo.FeatureFlags WHERE Visibility = N'enabled'`);
  return new Set(rows.map((row) => rowKey(String(row.FeatureKey), String(row.RoleName))));
}

/** True when any of `roles` has an `enabled` row for `key`. Never throws; any problem is false. */
export async function isFeatureEnabledForRoles(key: string, roles: readonly string[], deps: FeatureFlagDeps): Promise<boolean> {
  try {
    const now = (deps.now ?? Date.now)();
    if (cache === null || now - cache.loadedAt >= CACHE_MS || now < cache.loadedAt) {
      cache = { enabled: await loadEnabled(deps.connection), loadedAt: now };
    }
    return roles.some((role) => cache?.enabled.has(rowKey(key, role)) === true);
  } catch {
    return false;
  }
}

/** Forget the cached table. For tests only. */
export function resetFeatureFlagCache(): void {
  cache = null;
}
