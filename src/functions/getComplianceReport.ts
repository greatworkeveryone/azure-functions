// GET /api/getComplianceReport?asOf=YYYY-MM-DD&buildingId=<id|all>
//
// The Compliance report: what is out of compliance on a date, building by building, and
// what fixes it. Certificates of currency missing, expired or expiring within 30 days;
// trades a building has been set to require with no active contractor; service schedules
// overdue; defects periods in force. Commercial buildings only (residences never appear).
// Read-only, and it never blocks anything: warnings never stop an assignment. The CFO,
// directors, admin and facilities managers (ACTION_ROLES.viewOperationsReports). Archived
// records never appear; defects periods on test tenancies stay out unless an admin has
// Show test data on. Both parameters are optional: today (Darwin) and all commercial
// buildings.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { addMonthsClamped, isIsoDate, todayInDarwin } from "../darwinDate";
import { closeConnection, createRequestConnection } from "../db";
import { showTestParam } from "../test-data";
import { buildComplianceReport } from "../complianceReport/build";
import { loadComplianceData } from "../complianceReport/load";
import type { ComplianceScope } from "../complianceReport/types";

const MAX_YEARS_AHEAD = 10;

const badRequest = (error: string): HttpResponseInit => ({ status: 400, jsonBody: { error } });

type Params = { asOf: string; scope: ComplianceScope } | { error: string };

/**
 * buildingId: "all" (the default) or a whole number (manual buildings have negative ids).
 * asOf: today (Darwin) to ten years ahead. Services are checked against the next due date
 * as it stands today, so a past date would only look right by accident.
 */
export function readParams(request: HttpRequest, today: string): Params {
  const rawBuilding = request.query.get("buildingId")?.trim() ?? "";
  let scope: ComplianceScope = { all: true };
  if (rawBuilding !== "" && rawBuilding !== "all") {
    const buildingId = /^-?\d+$/.test(rawBuilding) ? Number(rawBuilding) : Number.NaN;
    if (!Number.isSafeInteger(buildingId) || buildingId === 0 || Math.abs(buildingId) > 2147483647) {
      return { error: "buildingId must be a building id or all" };
    }
    scope = { buildingId };
  }
  const asOf = request.query.get("asOf")?.trim() || today;
  if (!isIsoDate(asOf)) return { error: "asOf must be a date (YYYY-MM-DD)" };
  if (asOf < today) return { error: "asOf can't be in the past: services are checked against their next due date as it stands today" };
  if (asOf > addMonthsClamped(today, MAX_YEARS_AHEAD * 12)) return { error: `asOf can be at most ${MAX_YEARS_AHEAD} years ahead` };
  return { asOf, scope };
}

export async function getComplianceReport(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, ACTION_ROLES.viewOperationsReports.gate);
  if (denied) return denied;

  const params = readParams(request, todayInDarwin());
  if ("error" in params) return badRequest(params.error);

  let connection: Connection | undefined;
  try {
    const showTest = await showTestParam(request);
    connection = await createRequestConnection(token);
    const data = await loadComplianceData(connection, params.scope, params.asOf, showTest.value === true);
    if ("buildingId" in params.scope && data.buildings.length === 0) {
      return { status: 404, jsonBody: { error: "Building not found" } };
    }
    return {
      status: 200,
      headers: { "Cache-Control": "no-store" },
      jsonBody: buildComplianceReport({ asOf: params.asOf, data, generatedAt: new Date().toISOString(), scope: params.scope }),
    };
  } catch (error) {
    context.error("getComplianceReport failed:", error instanceof Error ? error.message : error);
    return errorResponse("Failed to build the compliance report", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getComplianceReport", { authLevel: "anonymous", handler: getComplianceReport, methods: ["GET"] });
