// POST /api/revokeTenancyScheduleSignOff   { TenantId, BuildingId?, Reason }
//
// Takes a sign-off back (PLAN WP24). The reason is required and is ledgered as
// schedule.sign_off_revoke in the same transaction. Response: { scheduleSignOff: null }.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import {
  beginTransaction,
  closeConnection,
  commitTransaction,
  createRequestConnection,
  executeQuery,
} from "../db";
import * as ledger from "../ledger";
import { resolveLedgerActor } from "../ledger/actor";
import {
  CLEAR_SIGN_OFF_SQL,
  lockTenantForSignOff,
  readSignOffText,
  readTenantKey,
  SIGN_OFF_ROLES,
} from "../scheduleSignOff";
import { invalidateTenantAndBuilding } from "../tenant-register-cache";
import { ledgerRefusal, rollbackQuietly } from "../tenancyScheduleWrite";

export async function revokeTenancyScheduleSignOff(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, SIGN_OFF_ROLES);
  if (denied) return denied;

  let connection;
  try {
    const body: unknown = await request.json();
    const key = readTenantKey(body);
    if (!key) return { status: 400, jsonBody: { error: "TenantId (a whole number) required" } };
    const reason = readSignOffText((body as Record<string, unknown>).Reason);
    if (!reason) return { status: 400, jsonBody: { error: "A reason is required to revoke a sign-off." } };

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();

    await beginTransaction(connection);
    try {
      const locked = await lockTenantForSignOff(connection, key);
      if (locked.kind === "refused") {
        await rollbackQuietly(connection);
        return locked.response;
      }
      if (!locked.signOff) {
        await rollbackQuietly(connection);
        return { status: 409, jsonBody: { code: "NOT_SIGNED_OFF", error: "This schedule is not signed off." } };
      }
      const buildingId = locked.row.BuildingId as number;
      await executeQuery(
        connection,
        `UPDATE dbo.Tenants SET ${CLEAR_SIGN_OFF_SQL} WHERE TenantId = @TenantId`,
        [{ name: "TenantId", type: TYPES.Int, value: key.tenantId }],
      );
      await ledger.record(connection, {
        action: "schedule.sign_off_revoke",
        actor,
        after: { signOff: null },
        before: { signOff: locked.signOff },
        buildingId,
        correlationId: ledger.newCorrelationId(),
        reason,
        subject: { id: key.tenantId, type: "tenancy" },
        tenantId: key.tenantId,
      });
      await commitTransaction(connection);
      invalidateTenantAndBuilding(key.tenantId, buildingId);
      return { status: 200, jsonBody: { scheduleSignOff: null } };
    } catch (err) {
      await rollbackQuietly(connection);
      throw err;
    }
  } catch (error: any) {
    const refusal = ledgerRefusal(error);
    if (refusal) return refusal;
    context.error("revokeTenancyScheduleSignOff failed:", error.message);
    return errorResponse("Failed to revoke the sign-off", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("revokeTenancyScheduleSignOff", {
  authLevel: "anonymous",
  handler: revokeTenancyScheduleSignOff,
  methods: ["POST"],
});
