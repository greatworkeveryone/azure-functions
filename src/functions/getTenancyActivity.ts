// GET /api/getTenancyActivity?tenantId=7   (PLAN §15, TR5)
//
//   200 { items, invoices, truncated, showsAmounts }
//
// A tenancy's work requests (myBuildings and Floorplan-native), jobs linked by
// Jobs.TenantID and the on-charges on those jobs, newest first, capped. Read-only;
// the amounts are the jobs' own OnchargeAmount and go only to ACTIVITY_AMOUNT_ROLES.
// Work requests carry a tenant NAME, not an id, so they match on the tenancy's
// building and its legal or trading name. Gate: the roles that may read a tenancy.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { errorResponse, extractToken, requireRole, rolesForRequest, rolesPassGate, unauthorizedResponse } from "../auth";
import { closeConnection, createRequestConnection, executeQuery } from "../db";
import { TENANCY_VIEW_ROLES } from "../rentReview/http";
import { ACTIVITY_AMOUNT_ROLES, ACTIVITY_CAP, buildTenancyActivity } from "../tenancyActivity/build";
import { showTestParam } from "../test-data";
import { WR_OVERLAY_JOIN, workRequestSelectColumns } from "../wr-overlay";

export async function getTenancyActivity(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, TENANCY_VIEW_ROLES);
  if (denied) return denied;

  const tenantId = Number(request.query.get("tenantId"));
  if (!Number.isInteger(tenantId) || tenantId <= 0) return { status: 400, jsonBody: { error: "tenantId must be a whole number" } };

  let connection;
  try {
    const showAmounts = rolesPassGate(await rolesForRequest(request), ACTIVITY_AMOUNT_ROLES);
    const showTest = await showTestParam(request);
    connection = await createRequestConnection(token);
    const capParam = { name: "Cap", type: TYPES.Int, value: ACTIVITY_CAP + 1 };
    const tenantParam = { name: "TenantId", type: TYPES.Int, value: tenantId };

    const tenants = await executeQuery(connection, "SELECT BuildingId, LegalName, TradingName FROM dbo.Tenants WHERE TenantId = @TenantId", [tenantParam]);
    if (tenants.length === 0) return { status: 404, jsonBody: { error: "Tenant not found" } };
    const tenant = tenants[0];

    // TR1 adds WorkRequests.IntakeState; until it exists on this database the existing Status is shown.
    const intake = await executeQuery(connection, "SELECT COL_LENGTH(N'dbo.WorkRequests', N'IntakeState') AS Len", []);

    const wrRows = await executeQuery(
      connection,
      `SELECT TOP (@Cap) ${workRequestSelectColumns()}, wr.SourceHost
         FROM WorkRequests wr ${WR_OVERLAY_JOIN}
        WHERE wr.BuildingID = @BuildingId
          AND COALESCE(o.TenantName, wr.TenantName) IN (@LegalName, @TradingName)
        ORDER BY wr.CreatedAt DESC`,
      [
        capParam,
        { name: "BuildingId", type: TYPES.Int, value: tenant.BuildingId },
        { name: "LegalName", type: TYPES.NVarChar, value: tenant.LegalName ?? null },
        { name: "TradingName", type: TYPES.NVarChar, value: tenant.TradingName ?? null },
      ],
    );
    if (intake[0]?.Len != null && wrRows.length > 0) {
      const states = await executeQuery(
        connection,
        "SELECT WorkRequestID, IntakeState FROM WorkRequests WHERE WorkRequestID IN (SELECT CAST(value AS INT) FROM OPENJSON(@Ids))",
        [{ name: "Ids", type: TYPES.NVarChar, value: JSON.stringify(wrRows.map((r) => r.WorkRequestID)) }],
      );
      const byId = new Map(states.map((r) => [r.WorkRequestID, r.IntakeState]));
      for (const row of wrRows) row.IntakeState = byId.get(row.WorkRequestID) ?? null;
    }
    const jobRows = await executeQuery(
      connection,
      `SELECT TOP (@Cap) JobID, WorkRequestID, JobCode, Title, Status, IsOnchargeable, OnchargeAmount, CreatedAt
         FROM Jobs
        WHERE TenantID = @TenantId AND IsArchived = 0 AND (IsTest = 0 OR @ShowTest = 1)
        ORDER BY CreatedAt DESC`,
      [tenantParam, showTest, capParam],
    );

    return {
      status: 200,
      headers: { "Cache-Control": "no-store" },
      jsonBody: { ...buildTenancyActivity(wrRows, jobRows, showAmounts), showsAmounts: showAmounts },
    };
  } catch (error) {
    context.error("getTenancyActivity failed:", error instanceof Error ? error.message : error);
    return errorResponse("Failed to load the tenancy's requests and charges", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getTenancyActivity", { authLevel: "anonymous", handler: getTenancyActivity, methods: ["GET"] });
