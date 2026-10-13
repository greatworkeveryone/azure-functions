// GET /api/previewHoldoverReset — admin only, read-only (PLAN WP23a, F22a).
//
// Before WP23a every inline edit re-sent the computed Status, so a lease that
// was edited after its expiry stored "holdover" for good. Status is now
// derived on read and only an explicit status edit stores it. This lists the
// rows still stuck: stored "holdover" although the expiry (Darwin date) is
// today or later. Resetting them to "current" is the one-off the plan calls
// for; it waits on a registered ledger action for status corrections, so this
// endpoint only reports what that reset would change.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { AppRole, errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { todayInDarwin } from "../darwinDate";
import { closeConnection, createRequestConnection, executeQuery } from "../db";

export async function previewHoldoverReset(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, [AppRole.ADMIN]);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    connection = await createRequestConnection(token);
    const today = todayInDarwin();
    const rows = await executeQuery(
      connection,
      `SELECT TenantId, BuildingId, LegalName, Expiry
       FROM dbo.Tenants
       WHERE Status = 'holdover' AND Expiry >= @Today
       ORDER BY BuildingId, LegalName`,
      [{ name: "Today", type: TYPES.Date, value: today }],
    );
    const tenancies = rows.map((row) => ({
      buildingId: row.BuildingId as number,
      expiry: row.Expiry instanceof Date ? row.Expiry.toISOString().slice(0, 10) : String(row.Expiry ?? ""),
      legalName: row.LegalName as string,
      tenantId: row.TenantId as number,
    }));
    return { status: 200, jsonBody: { asOf: today, tenancies } };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("previewHoldoverReset failed:", message);
    return errorResponse("Failed to list stored holdover tenancies", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("previewHoldoverReset", {
  authLevel: "anonymous",
  handler: previewHoldoverReset,
  methods: ["GET"],
});
