// Whether dbo.Tenants has the structured option columns (migration 106, applied
// by hand on live; data review S2-1). Until it does, the register, a tenant's
// detail, the reviews feed and a save's re-read must not name them: an unknown
// column fails the whole query (and a save would commit, then answer 500).
//
// The answer is cached, as in buildingCategoryColumn.ts, but learned from the
// reads themselves so a read stays one round trip: the columns are assumed
// present; a query that fails naming one of them (SQL Server error 207) marks
// them absent and is retried once with NULLs, which read as "not recorded".
// Only reads outside a transaction come here. While absent, COL_LENGTH is asked
// again at most once a minute, so applying 106 takes effect without a restart.

import type { Connection } from "tedious";
import { executeQuery, type SqlParam, type SqlRow } from "./db";

export const LEASE_OPTION_COLUMNS = "OptionsTotal, OptionsRemaining, OptionTermMonths";
const ABSENT_COLUMNS = "CAST(NULL AS INT) AS OptionsTotal, CAST(NULL AS INT) AS OptionsRemaining, CAST(NULL AS INT) AS OptionTermMonths";
const RECHECK_MS = 60_000;

let absentSince: number | null = null;

/** A query refused because it named a 106 column the database doesn't have. */
export function isMissingLeaseOptionColumn(error: unknown): boolean {
  const failure = error as { message?: unknown; number?: unknown } | null;
  return failure?.number === 207 && /Options(Total|Remaining)|OptionTermMonths/.test(String(failure.message ?? ""));
}

async function stillAbsent(connection: Connection): Promise<boolean> {
  if (absentSince === null) return false;
  if (Date.now() - absentSince < RECHECK_MS) return true;
  const probe = await executeQuery(connection, "SELECT COL_LENGTH('dbo.Tenants', 'OptionsRemaining') AS Len");
  if (probe[0]?.Len == null) {
    absentSince = Date.now();
    return true;
  }
  absentSince = null;
  return false;
}

/** Runs a read whose select list takes the option columns (`build` puts them in), or NULLs for them until 106. */
export async function selectWithLeaseOptions(connection: Connection, build: (columns: string) => string, params: SqlParam[]): Promise<SqlRow[]> {
  if (await stillAbsent(connection)) return executeQuery(connection, build(ABSENT_COLUMNS), params);
  try {
    return await executeQuery(connection, build(LEASE_OPTION_COLUMNS), params);
  } catch (error) {
    if (!isMissingLeaseOptionColumn(error)) throw error;
    absentSince = Date.now();
    return executeQuery(connection, build(ABSENT_COLUMNS), params);
  }
}

/** Forget what was learned. For tests only. */
export function resetLeaseOptionColumns(): void {
  absentSince = null;
}
