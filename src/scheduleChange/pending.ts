// Changes awaiting a decision, for every read that returns rent (PLAN WP26c,
// D24): "Includes {n} changes awaiting a director". Two kinds today:
//
//   relief       a rent relief request waiting for a director (ScheduleChangeRequests)
//   rent_review  a rent review waiting for approval (WP26: awaiting_approval)
//
// Neither is in any figure until it is decided: a relief reaches the schedule
// when a director ratifies it, a review when it is approved and applied. Every
// read carries
//
//   pendingChanges: { count, items: [{ requestId, kind, from, to, summary, tenantId, tenantName, ... }] }
//
// where requestId is the request's id or the review's, from and to the dates it
// would change (a review: its date, to null). The tenancy readers' reads get the
// figures and who asked why (`full`); the reads whose audience never sees rent
// (the Next 90 days feed, the portfolio figures facilities read) get dates and
// names only (`dates_only`). A list across tenancies (a building, the portfolio)
// leaves out archived tenancies, as getRentReviews does; naming one tenancy
// still returns its own.

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery, type SqlParam, type SqlRow } from "../db";
import { formatDisplayDate } from "../digest/format";
import { sqlDateToIso } from "../nextReviewDate";
import { chosenFigures, parseCalc } from "../rentReviewCalc";
import type { PendingChangeMarker } from "../scheduleCharges";
import { isoTimestamp } from "../tenancyScheduleWrite";
import { changeTenantName, reliefOfRow } from "./dto";
import { reliefSummary } from "./types";

export interface PendingChangeItem extends PendingChangeMarker {
  buildingId: number | null;
  /** Who asked (a relief) or prepared it (a review), when, and why: `full` reads only. */
  reason?: string | null;
  requestedAt?: string | null;
  requestedByName?: string | null;
  tenantId: number;
  tenantName: string;
}

export interface PendingChanges {
  count: number;
  items: PendingChangeItem[];
}

export type PendingScope = { all: true } | { buildingId: number } | { tenantId: number };
export type PendingDetail = "dates_only" | "full";

const money = (value: number): string => new Intl.NumberFormat("en-AU", { currency: "AUD", style: "currency" }).format(value);

function scopeSql(scope: PendingScope, alias: string): { params: SqlParam[]; sql: string } {
  if ("tenantId" in scope) return { params: [{ name: "TenantId", type: TYPES.Int, value: scope.tenantId }], sql: ` AND ${alias}.TenantId = @TenantId` };
  if ("buildingId" in scope) {
    return { params: [{ name: "BuildingId", type: TYPES.Int, value: scope.buildingId }], sql: " AND t.BuildingId = @BuildingId AND t.ArchivedAt IS NULL" };
  }
  return { params: [], sql: " AND t.ArchivedAt IS NULL" };
}

const RELIEF_SQL = `SELECT c.RequestId, c.TenantId, c.Kind, c.Payload, c.Reason, c.State, c.RequestedByName, c.RequestedAt,
    t.BuildingId, t.LegalName, t.TradingName
  FROM dbo.ScheduleChangeRequests c
  INNER JOIN dbo.Tenants t ON t.TenantId = c.TenantId
  WHERE c.State = N'pending'`;

const REVIEW_SQL = `SELECT r.ReviewId, r.TenantId, r.ScheduledFor, r.State, r.Calc, r.PreparedByName, r.SubmittedAt,
    t.BuildingId, t.LegalName, t.TradingName
  FROM dbo.RentReviews r
  INNER JOIN dbo.Tenants t ON t.TenantId = r.TenantId
  WHERE r.State = 'awaiting_approval'`;

const buildingOf = (row: SqlRow): number | null => (row.BuildingId === null || row.BuildingId === undefined ? null : Number(row.BuildingId));

function reliefItem(row: SqlRow, detail: PendingDetail): PendingChangeItem | null {
  const relief = row.State === "pending" ? reliefOfRow(row) : null;
  if (!relief) return null;
  return {
    buildingId: buildingOf(row),
    from: relief.from,
    kind: "relief",
    requestId: String(row.RequestId),
    summary: reliefSummary(relief, { datesOnly: detail === "dates_only" }),
    tenantId: Number(row.TenantId),
    tenantName: changeTenantName(row),
    to: relief.to,
    ...(detail === "full"
      ? { reason: typeof row.Reason === "string" ? row.Reason : null, requestedAt: isoTimestamp(row.RequestedAt), requestedByName: typeof row.RequestedByName === "string" ? row.RequestedByName : null }
      : {}),
  };
}

function reviewItem(row: SqlRow, detail: PendingDetail): PendingChangeItem | null {
  const scheduledFor = sqlDateToIso(row.ScheduledFor);
  if (!scheduledFor || row.State !== "awaiting_approval") return null;
  const calc = parseCalc(row.Calc);
  const figures = calc ? chosenFigures(calc) : null;
  const what = `Rent review ${formatDisplayDate(scheduledFor)}`;
  return {
    buildingId: buildingOf(row),
    from: scheduledFor,
    kind: "rent_review",
    requestId: String(row.ReviewId),
    summary:
      detail === "full" && figures
        ? `${what}: ${money(figures.currentAnnual)} to ${money(figures.newAnnual)} a year, awaiting approval`
        : `${what}, awaiting approval`,
    tenantId: Number(row.TenantId),
    tenantName: changeTenantName(row),
    to: null,
    ...(detail === "full"
      ? { reason: calc?.override?.reason ?? null, requestedAt: isoTimestamp(row.SubmittedAt), requestedByName: typeof row.PreparedByName === "string" ? row.PreparedByName : null }
      : {}),
  };
}

const byDate = (a: PendingChangeItem, b: PendingChangeItem): number =>
  String(a.from).localeCompare(String(b.from)) || a.requestId.localeCompare(b.requestId);

/** Every change awaiting a decision in `scope`, oldest date first. */
export async function loadPendingChanges(connection: Connection, scope: PendingScope, detail: PendingDetail): Promise<PendingChangeItem[]> {
  // Scope fragments are literal "AND col = @param" text; the values ride in params.
  const { params: reliefParams, sql: whereSqlA } = scopeSql(scope, "c");
  const { params: reviewParams, sql: whereSqlB } = scopeSql(scope, "r");
  const reliefRows = await executeQuery(connection, `${RELIEF_SQL}${whereSqlA}`, reliefParams);
  const reviewRows = await executeQuery(connection, `${REVIEW_SQL}${whereSqlB}`, reviewParams);
  return [
    ...reliefRows.map((row) => reliefItem(row, detail)),
    ...reviewRows.map((row) => reviewItem(row, detail)),
  ]
    .filter((item): item is PendingChangeItem => item !== null)
    .sort(byDate);
}

export const pendingChangesOf = (items: readonly PendingChangeItem[]): PendingChanges => ({ count: items.length, items: [...items] });

/** The items of one tenancy. */
export const pendingFor = (items: readonly PendingChangeItem[], tenantId: number): PendingChanges =>
  pendingChangesOf(items.filter((item) => item.tenantId === tenantId));
