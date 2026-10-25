import { TYPES } from "tedious";
import type { SqlParam } from "../db";
import { darwinDayStartUtc, darwinNextDayStartUtc, parseDarwinDate } from "./darwinTime";

export type DecisionSort = "impact" | "occurredAt";
export type DecisionFormat = "csv" | "json";

export interface DecisionFilters {
  /** An exact action code, or a prefix ending in "." covering a whole domain. */
  action?: { exact: string } | { prefix: string };
  actorUserId?: number;
  buildingId?: number;
  /** The contractor a money row is for, as the id it carries in `after` or in
   *  `before` (a deletion written before `after` was filled in has it only
   *  there). */
  contractorId?: number;
  exceptionsOnly: boolean;
  format: DecisionFormat;
  /** Inclusive: the instant the `from` day begins in Darwin. */
  from?: Date;
  jobId?: number;
  sort: DecisionSort;
  tenantId?: number;
  /** Exclusive: the instant the day after `to` begins in Darwin. */
  toExclusive?: Date;
}

export type ParsedDecisionFilters = { filters: DecisionFilters; ok: true } | { error: string; ok: false };

const ACTION_CODE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*\.?$/;
const MAX_ACTION_CHARS = 64;
const INT_MAX = 2_147_483_647;

function fail(error: string): ParsedDecisionFilters {
  return { error, ok: false };
}

/** undefined = absent, null = present but not a positive whole number. */
function idParam(query: URLSearchParams, name: string): number | null | undefined {
  const raw = query.get(name)?.trim();
  if (!raw) return undefined;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= INT_MAX ? n : null;
}

/** Validates the getDecisions query string. `from` and `to` are Darwin calendar
 *  dates (YYYY-MM-DD) and both ends are inclusive. */
export function parseDecisionFilters(query: URLSearchParams): ParsedDecisionFilters {
  const filters: DecisionFilters = { exceptionsOnly: false, format: "json", sort: "occurredAt" };

  const from = query.get("from")?.trim();
  if (from) {
    const day = parseDarwinDate(from);
    if (!day) return fail("from must be a date as YYYY-MM-DD");
    filters.from = darwinDayStartUtc(day);
  }
  const to = query.get("to")?.trim();
  if (to) {
    const day = parseDarwinDate(to);
    if (!day) return fail("to must be a date as YYYY-MM-DD");
    filters.toExclusive = darwinNextDayStartUtc(day);
  }
  if (filters.from && filters.toExclusive && filters.from >= filters.toExclusive) {
    return fail("from must not be after to");
  }

  const actorUserId = idParam(query, "actorUserId");
  if (actorUserId === null) return fail("actorUserId must be a whole number");
  if (actorUserId !== undefined) filters.actorUserId = actorUserId;

  const buildingId = idParam(query, "buildingId");
  if (buildingId === null) return fail("buildingId must be a whole number");
  if (buildingId !== undefined) filters.buildingId = buildingId;

  const tenantId = idParam(query, "tenantId");
  if (tenantId === null) return fail("tenantId must be a whole number");
  if (tenantId !== undefined) filters.tenantId = tenantId;

  const jobId = idParam(query, "jobId");
  if (jobId === null) return fail("jobId must be a whole number");
  if (jobId !== undefined) filters.jobId = jobId;

  const contractorId = idParam(query, "contractorId");
  if (contractorId === null) return fail("contractorId must be a whole number");
  if (contractorId !== undefined) filters.contractorId = contractorId;

  const action = query.get("action")?.trim();
  if (action) {
    if (action.length > MAX_ACTION_CHARS || !ACTION_CODE.test(action)) {
      return fail("action must be an action code, or a prefix ending in '.'");
    }
    filters.action = action.endsWith(".") ? { prefix: action } : { exact: action };
  }

  const exceptionsOnly = query.get("exceptionsOnly")?.trim().toLowerCase();
  filters.exceptionsOnly = exceptionsOnly === "true" || exceptionsOnly === "1";

  const sort = query.get("sort")?.trim().toLowerCase();
  if (sort) {
    if (sort === "occurredat") filters.sort = "occurredAt";
    else if (sort === "impact") filters.sort = "impact";
    else return fail("sort must be occurredAt or impact");
  }

  const format = query.get("format")?.trim().toLowerCase();
  if (format) {
    if (format === "csv" || format === "json") filters.format = format;
    else return fail("format must be json or csv");
  }

  return { filters, ok: true };
}

/** Escapes the LIKE wildcards. Action codes are full of underscores, which LIKE
 *  would otherwise treat as "any one character". */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_[]/g, (ch) => `\\${ch}`);
}

/** The WHERE clause (or "") and its parameters. Every value is bound; the only
 *  text in the clause is literal. */
export function buildDecisionWhere(f: DecisionFilters): { params: SqlParam[]; whereSql: string } {
  const parts: string[] = [];
  const params: SqlParam[] = [];

  // DATETIME2(3) column: match the parameter's scale so the index can seek.
  if (f.from) {
    parts.push("OccurredAt >= @From");
    params.push({ name: "From", options: { scale: 3 }, type: TYPES.DateTime2, value: f.from });
  }
  if (f.toExclusive) {
    parts.push("OccurredAt < @To");
    params.push({ name: "To", options: { scale: 3 }, type: TYPES.DateTime2, value: f.toExclusive });
  }
  if (f.actorUserId !== undefined) {
    parts.push("ActorUserId = @ActorUserId");
    params.push({ name: "ActorUserId", type: TYPES.Int, value: f.actorUserId });
  }
  if (f.action) {
    if ("exact" in f.action) {
      parts.push("Action = @Action");
      params.push({ name: "Action", type: TYPES.NVarChar, value: f.action.exact });
    } else {
      parts.push("Action LIKE @ActionPrefix ESCAPE '\\'");
      params.push({ name: "ActionPrefix", type: TYPES.NVarChar, value: `${escapeLike(f.action.prefix)}%` });
    }
  }
  if (f.buildingId !== undefined) {
    parts.push("BuildingId = @BuildingId");
    params.push({ name: "BuildingId", type: TYPES.Int, value: f.buildingId });
  }
  if (f.tenantId !== undefined) {
    parts.push("TenantId = @TenantId");
    params.push({ name: "TenantId", type: TYPES.Int, value: f.tenantId });
  }
  if (f.jobId !== undefined) {
    parts.push("JobId = @JobId");
    params.push({ name: "JobId", type: TYPES.Int, value: f.jobId });
  }
  if (f.contractorId !== undefined) {
    // A money row carries the contractor's id in `after`, and in `before` where it
    // has one: a deletion written before `after` was filled in has it only there.
    // TRY_CAST so a row whose value isn't a whole number is skipped, not an error.
    parts.push(
      "(TRY_CAST(JSON_VALUE([After], '$.contractorId') AS INT) = @ContractorId OR TRY_CAST(JSON_VALUE([Before], '$.contractorId') AS INT) = @ContractorId)",
    );
    params.push({ name: "ContractorId", type: TYPES.Int, value: f.contractorId });
  }
  if (f.exceptionsOnly) parts.push("IsException = 1");

  return { params, whereSql: parts.length > 0 ? `WHERE ${parts.join(" AND ")}` : "" };
}
