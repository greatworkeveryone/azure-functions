// GET /api/getMaintenanceSpendReport?financialYear=2025-26&buildingId=<id|all>
//
// The Maintenance spend report: approved contractor invoices by building and trade
// for an Australian financial year (1 July to 30 June, Darwin time), ex GST, with
// the on-charges recovered from tenants and the top five trades. Commercial
// buildings only (residences never appear). Read-only. The CFO, directors, admin
// and facilities managers (ACTION_ROLES.viewOperationsReports). Test records are
// left out unless an admin has Show test data on. Both parameters are optional:
// this financial year and all commercial buildings.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { todayInDarwin } from "../darwinDate";
import { closeConnection, createRequestConnection } from "../db";
import { showTestParam } from "../test-data";
import { buildMaintenanceSpend } from "../maintenanceSpend/build";
import { parseFinancialYear, type FinancialYear } from "../maintenanceSpend/financialYear";
import { loadMaintenanceSpendData } from "../maintenanceSpend/load";
import type { MaintenanceSpendScope } from "../maintenanceSpend/types";

const badRequest = (error: string): HttpResponseInit => ({ status: 400, jsonBody: { error } });

type Params = { financialYear: FinancialYear; scope: MaintenanceSpendScope } | { error: string };

/** buildingId: "all" (the default) or a whole number (manual buildings have negative ids); financialYear: "2025-26". */
export function readParams(request: HttpRequest, today: string): Params {
  const rawBuilding = request.query.get("buildingId")?.trim() ?? "";
  let scope: MaintenanceSpendScope = { all: true };
  if (rawBuilding !== "" && rawBuilding !== "all") {
    const buildingId = /^-?\d+$/.test(rawBuilding) ? Number(rawBuilding) : Number.NaN;
    if (!Number.isSafeInteger(buildingId) || buildingId === 0 || Math.abs(buildingId) > 2147483647) {
      return { error: "buildingId must be a building id or all" };
    }
    scope = { buildingId };
  }
  const year = parseFinancialYear(request.query.get("financialYear"), today);
  if ("error" in year) return year;
  return { financialYear: year, scope };
}

export async function getMaintenanceSpendReport(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
    const data = await loadMaintenanceSpendData(connection, params.scope, params.financialYear, showTest.value === true);
    if ("buildingId" in params.scope && data.buildings.length === 0) {
      return { status: 404, jsonBody: { error: "Building not found" } };
    }
    return {
      status: 200,
      headers: { "Cache-Control": "no-store" },
      jsonBody: buildMaintenanceSpend({ data, financialYear: params.financialYear, generatedAt: new Date().toISOString(), scope: params.scope }),
    };
  } catch (error) {
    context.error("getMaintenanceSpendReport failed:", error instanceof Error ? error.message : error);
    return errorResponse("Failed to build the maintenance spend report", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getMaintenanceSpendReport", { authLevel: "anonymous", handler: getMaintenanceSpendReport, methods: ["GET"] });
