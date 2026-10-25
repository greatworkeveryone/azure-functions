// GET /api/getTenancySchedule?buildingId=<id|all>&asOf=YYYY-MM-DD
//
// The Tenancy Schedule report: every lease's charges as the register charges them
// on a date (today or later), reviews, vacancies, a property summary and the data
// gaps. Read-only. Directors and the CFO (ACTION_ROLES.viewTenancySchedule; admin
// passes every gate). Test records are left out unless an admin has Show test data
// on; archived ones never appear. Contract: command-centre
// .harness/TENANCY-SCHEDULE-REPORT-2026-10-22.md.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { addMonthsClamped, isIsoDate, todayInDarwin } from "../darwinDate";
import { closeConnection, createRequestConnection } from "../db";
import { showTestParam } from "../test-data";
import { buildTenancySchedule } from "../tenancySchedule/build";
import { loadTenancyScheduleData, type TenancyScheduleScope } from "../tenancySchedule/load";

const MAX_YEARS_AHEAD = 10;

const badRequest = (error: string): HttpResponseInit => ({ status: 400, jsonBody: { error } });

type Params = { asOf: string; scope: TenancyScheduleScope } | { error: string };

/** buildingId: "all" or a whole number (manual buildings have negative ids); asOf: today (Darwin) to 10 years ahead. */
export function readParams(request: HttpRequest, today: string): Params {
  const rawBuilding = request.query.get("buildingId")?.trim() ?? "";
  let scope: TenancyScheduleScope;
  if (rawBuilding === "all") {
    scope = { all: true };
  } else {
    const buildingId = /^-?\d+$/.test(rawBuilding) ? Number(rawBuilding) : NaN;
    if (!Number.isSafeInteger(buildingId) || buildingId === 0 || Math.abs(buildingId) > 2147483647) {
      return { error: "buildingId must be a building id or all" };
    }
    scope = { buildingId };
  }
  const asOf = request.query.get("asOf")?.trim() || today;
  if (!isIsoDate(asOf)) return { error: "asOf must be a date (YYYY-MM-DD)" };
  if (asOf < today) return { error: "asOf can't be in the past: the report shows who is let to whom today or later" };
  if (asOf > addMonthsClamped(today, MAX_YEARS_AHEAD * 12)) return { error: `asOf can be at most ${MAX_YEARS_AHEAD} years ahead` };
  return { asOf, scope };
}

export async function getTenancySchedule(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, ACTION_ROLES.viewTenancySchedule.gate);
  if (denied) return denied;

  const params = readParams(request, todayInDarwin());
  if ("error" in params) return badRequest(params.error);

  let connection: Connection | undefined;
  try {
    const showTest = await showTestParam(request);
    connection = await createRequestConnection(token);
    const data = await loadTenancyScheduleData(connection, params.scope, showTest.value === true);
    if ("buildingId" in params.scope && data.buildings.length === 0) {
      return { status: 404, jsonBody: { error: "Building not found" } };
    }
    return {
      status: 200,
      headers: { "Cache-Control": "no-store" },
      jsonBody: buildTenancySchedule({ asOf: params.asOf, data, generatedAt: new Date().toISOString() }),
    };
  } catch (error) {
    context.error("getTenancySchedule failed:", error instanceof Error ? error.message : error);
    return errorResponse("Failed to build the tenancy schedule", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getTenancySchedule", { authLevel: "anonymous", handler: getTenancySchedule, methods: ["GET"] });
