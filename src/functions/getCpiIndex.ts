// getCpiIndex — GET /api/getCpiIndex?region=AUS|DARWIN[&from=YYYY-Qn]
//
// Quarterly ABS CPI index values (All groups, Original) for one region, as
// synced into dbo.CpiIndex by tenancyCpiSyncTimer, oldest first; `from` is an
// inclusive lower bound. Used by the schedule editor's "Fill from ABS" and,
// later, by the rent-review calculation.
//
// Every period carries the reference base its value is expressed in. Two index
// values are only comparable if their bases are equal, so consumers must check
// that rather than assume it; a base can change under a rebase and the sync then
// restates the whole table (see migration 095).
//
// An empty table is a normal answer (nothing synced yet): 200 with no periods.

import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { TYPES } from "tedious";
import {
  AppRole,
  errorResponse,
  extractToken,
  requireRole,
  unauthorizedResponse,
} from "../auth";
import { CPI_REGIONS, CpiRegion, isCpiPeriod } from "../cpiAbs";
import { closeConnection, createRequestConnection, executeQuery } from "../db";

// Mirrors the tenancy register's read gate: getRegisterTenants and
// getRegisterTenant in tenancy.ts. If that list changes, change this one (a
// test compares them).
export const VIEW_CPI_INDEX_ROLES: readonly AppRole[] = [
  AppRole.ACCOUNTS,
  AppRole.ACCOUNTS_APPROVAL,
  AppRole.ADMIN,
  AppRole.DIRECTOR,
];

// Sorts before every real period, so one query serves with and without `from`.
const EARLIEST_PERIOD = "0000-Q1";

export interface CpiIndexPeriod {
  period: string;
  indexValue: number;
  /** null for a row written before the base was recorded: not comparable */
  referenceBase: string | null;
}

export interface CpiIndexResponse {
  region: CpiRegion;
  latestPeriod: string | null;
  /** Base of the latest period. */
  referenceBase: string | null;
  dataflow: string | null;
  sourceKey: string | null;
  /** When the sync last confirmed these rows against ABS. */
  fetchedAt: string | null;
  periods: CpiIndexPeriod[];
}

function toIso(value: unknown): string | null {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toResponse(
  region: CpiRegion,
  rows: Array<Record<string, unknown>>,
): CpiIndexResponse {
  const periods: CpiIndexPeriod[] = rows.map((row) => ({
    period: String(row.Period),
    indexValue: Number(row.IndexValue),
    referenceBase: typeof row.ReferenceBase === "string" ? row.ReferenceBase : null,
  }));
  const latest = rows.length > 0 ? rows[rows.length - 1] : undefined;
  const fetchedAt = rows
    .map((row) => toIso(row.FetchedAt))
    .filter((iso): iso is string => iso !== null)
    .sort()
    .pop();
  return {
    region,
    latestPeriod: latest ? String(latest.Period) : null,
    referenceBase: typeof latest?.ReferenceBase === "string" ? latest.ReferenceBase : null,
    dataflow: typeof latest?.Dataflow === "string" ? latest.Dataflow : null,
    sourceKey: typeof latest?.SourceKey === "string" ? latest.SourceKey : null,
    fetchedAt: fetchedAt ?? null,
    periods,
  };
}

export async function getCpiIndex(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, VIEW_CPI_INDEX_ROLES);
  if (roleCheck) return roleCheck;

  const regionParam = (request.query.get("region") ?? "").trim().toUpperCase();
  const region = CPI_REGIONS.find((r) => r === regionParam);
  if (!region) {
    return { status: 400, jsonBody: { error: `region must be one of ${CPI_REGIONS.join(", ")}` } };
  }

  const fromParam = (request.query.get("from") ?? "").trim().toUpperCase();
  if (fromParam !== "" && !isCpiPeriod(fromParam)) {
    return { status: 400, jsonBody: { error: "from must be a quarter such as 2025-Q4" } };
  }

  let connection;
  try {
    connection = await createRequestConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT Period, IndexValue, ReferenceBase, SourceKey, Dataflow, FetchedAt
       FROM dbo.CpiIndex
       WHERE Region = @Region AND Period >= @From
       ORDER BY Period`,
      [
        { name: "Region", type: TYPES.NVarChar, value: region },
        { name: "From", type: TYPES.NVarChar, value: fromParam || EARLIEST_PERIOD },
      ],
    );
    return { status: 200, jsonBody: toResponse(region, rows) };
  } catch (error: unknown) {
    context.error("getCpiIndex failed:", error instanceof Error ? error.message : String(error));
    return errorResponse("Failed to fetch CPI index", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getCpiIndex", {
  methods: ["GET"],
  authLevel: "anonymous",
  handler: getCpiIndex,
});
