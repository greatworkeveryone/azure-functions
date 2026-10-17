// POST /api/signOffTenancySchedule   { TenantId, BuildingId?, Note?, ScheduleVersion? }
//
// An accounts manager, the CFO or a director signs a tenancy's schedule off as
// verified against the lease (PLAN WP24, D7). Ledgered as schedule.sign_off in
// the same transaction. ScheduleVersion is the version the person was shown
// when they confirmed: if the schedule has moved on since, the sign-off is
// refused rather than vouching for something they did not see.
// Response: { scheduleSignOff, scheduleVersion, rowVersion }.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import {
  errorResponse,
  extractToken,
  unauthorizedResponse,
  verifiedIdentityFromRequest,
} from "../auth";
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
  lockTenantForSignOff,
  readSignOffText,
  readTenantKey,
  scheduleSignOffFromRow,
  requireSignOffRole,
} from "../scheduleSignOff";
import { invalidateTenantAndBuilding } from "../tenant-register-cache";
import { conflictResponse, isoTimestamp, ledgerRefusal, rollbackQuietly, rowVersionHex } from "../tenancyScheduleWrite";

export async function signOffTenancySchedule(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireSignOffRole(request);
  if (denied) return denied;
  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  let connection;
  try {
    const body: unknown = await request.json();
    const key = readTenantKey(body);
    if (!key) return { status: 400, jsonBody: { error: "TenantId (a whole number) required" } };
    const note = readSignOffText((body as Record<string, unknown>).Note);
    const expected = (body as Record<string, unknown>).ScheduleVersion;
    if (expected !== undefined && !(typeof expected === "number" && Number.isInteger(expected) && expected >= 0)) {
      return { status: 400, jsonBody: { error: "ScheduleVersion must be a non-negative integer" } };
    }

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
      const { row, signOff } = locked;
      if (row.Status === "vacated") {
        await rollbackQuietly(connection);
        return { status: 409, jsonBody: { error: "A vacated tenancy has no schedule to sign off." } };
      }
      if (signOff) {
        await rollbackQuietly(connection);
        return {
          status: 409,
          jsonBody: {
            code: "ALREADY_SIGNED_OFF",
            error: `This schedule was already signed off by ${signOff.by}.`,
            signOff,
          },
        };
      }
      const version = Number(row.ScheduleVersion ?? 0);
      if (expected !== undefined && expected !== version) {
        await rollbackQuietly(connection);
        return conflictResponse(
          { changedAt: isoTimestamp(row.UpdatedAt), changedBy: (row.UpdatedByName as string | null) ?? null },
          { scheduleVersion: version },
        );
      }

      const updated = await executeQuery(
        connection,
        `UPDATE dbo.Tenants
            SET ScheduleSignedOffAt = SYSUTCDATETIME(), ScheduleSignedOffById = @SignedOffById,
                ScheduleSignedOffByName = @SignedOffByName, ScheduleSignOffNote = @Note
         OUTPUT INSERTED.ScheduleSignedOffAt, INSERTED.ScheduleSignedOffByName,
                INSERTED.ScheduleSignOffNote, INSERTED.RowVersion
          WHERE TenantId = @TenantId`,
        [
          { name: "SignedOffById", type: TYPES.NVarChar, value: identity.oid },
          { name: "SignedOffByName", type: TYPES.NVarChar, value: identity.name },
          { name: "Note", type: TYPES.NVarChar, value: note },
          { name: "TenantId", type: TYPES.Int, value: key.tenantId },
        ],
      );
      const scheduleSignOff = scheduleSignOffFromRow(updated[0] ?? {});
      await ledger.record(connection, {
        action: "schedule.sign_off",
        actor,
        after: { scheduleVersion: version, signOff: scheduleSignOff },
        before: { signOff: null },
        buildingId: row.BuildingId as number,
        correlationId: ledger.newCorrelationId(),
        subject: { id: key.tenantId, type: "tenancy" },
        tenantId: key.tenantId,
      });
      await commitTransaction(connection);
      invalidateTenantAndBuilding(key.tenantId, row.BuildingId as number);
      return {
        status: 200,
        jsonBody: { rowVersion: rowVersionHex(updated[0]?.RowVersion), scheduleSignOff, scheduleVersion: version },
      };
    } catch (err) {
      await rollbackQuietly(connection);
      throw err;
    }
  } catch (error: any) {
    const refusal = ledgerRefusal(error);
    if (refusal) return refusal;
    context.error("signOffTenancySchedule failed:", error.message);
    return errorResponse("Failed to sign off the schedule", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("signOffTenancySchedule", {
  authLevel: "anonymous",
  handler: signOffTenancySchedule,
  methods: ["POST"],
});
