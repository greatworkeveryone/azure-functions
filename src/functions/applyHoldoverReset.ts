// POST /api/applyHoldoverReset — admin only (PLAN WP23a, F22a). The apply half
// of previewHoldoverReset: sets stored "holdover" back to "current" for the
// tenancies the admin picked from the preview.
//
//   { TenantIds: [12, 15], Reason?: "…" }
//
// Positive selection only — never "all". In one transaction each picked row is
// re-checked under an update lock: still stored as holdover, with an expiry
// (Darwin date) today or later. Those are reset, each with one
// tenancy.holdover_reset ledger row (one CorrelationId for the run); the rest
// are skipped and reported. Holdover is derived on read from the expiry
// (deriveTenantStatus), so a reset row still reads holdover once its expiry
// passes.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { AppRole, errorResponse, extractToken, oidFromToken, requireRole, unauthorizedResponse } from "../auth";
import { todayInDarwin } from "../darwinDate";
import {
  beginTransaction,
  closeConnection,
  commitTransaction,
  createRequestConnection,
  executeQuery,
  type SqlParam,
} from "../db";
import * as ledger from "../ledger";
import { resolveLedgerActor } from "../ledger/actor";
import { sqlDateToIso } from "../nextReviewDate";
import { invalidateTenantAndBuilding } from "../tenant-register-cache";
import { ledgerRefusal, rollbackQuietly } from "../tenancyScheduleWrite";

const MAX_TENANCIES = 500;
const REASON_MAX = 2000;

type SkipReason = "expiry_passed" | "no_expiry" | "not_found" | "not_holdover";

interface ResetRow {
  buildingId: number;
  expiry: string;
  legalName: string;
  tenantId: number;
}

function parseBody(body: unknown): { reason: string | null; tenantIds: number[] } | string {
  if (!body || typeof body !== "object") return "Send the TenantIds picked from the preview";
  const { Reason, TenantIds } = body as Record<string, unknown>;
  if (!Array.isArray(TenantIds) || TenantIds.length === 0) return "TenantIds must list the tenancies to reset";
  if (TenantIds.length > MAX_TENANCIES) return `At most ${MAX_TENANCIES} tenancies at a time`;
  if (!TenantIds.every((id) => typeof id === "number" && Number.isInteger(id) && id > 0)) {
    return "TenantIds must be positive whole numbers";
  }
  if (Reason !== undefined && Reason !== null && (typeof Reason !== "string" || Reason.length > REASON_MAX)) {
    return `Reason must be text of at most ${REASON_MAX} characters`;
  }
  const reason = typeof Reason === "string" && Reason.trim() !== "" ? Reason.trim() : null;
  return { reason, tenantIds: [...new Set(TenantIds as number[])] };
}

function skipReason(row: Record<string, unknown> | undefined, today: string): SkipReason | null {
  if (!row) return "not_found";
  if (row.Status !== "holdover") return "not_holdover";
  const expiry = sqlDateToIso(row.Expiry);
  if (!expiry) return "no_expiry";
  return expiry < today ? "expiry_passed" : null;
}

export async function applyHoldoverReset(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, [AppRole.ADMIN]);
  if (roleCheck) return roleCheck;

  let parsed: ReturnType<typeof parseBody>;
  try {
    parsed = parseBody(await request.json());
  } catch {
    parsed = parseBody(null);
  }
  if (typeof parsed === "string") return { status: 400, jsonBody: { error: parsed } };
  const { reason, tenantIds } = parsed;

  let connection;
  try {
    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();
    const today = todayInDarwin();
    const placeholders = tenantIds.map((_, idx) => `@Id${idx}`).join(", ");
    const params: SqlParam[] = tenantIds.map((id, idx) => ({ name: `Id${idx}`, type: TYPES.Int, value: id }));

    await beginTransaction(connection);
    const reset: ResetRow[] = [];
    const skipped: Array<{ reason: SkipReason; tenantId: number }> = [];
    try {
      const rows = await executeQuery(
        connection,
        `SELECT TenantId, BuildingId, LegalName, Status, Expiry
         FROM dbo.Tenants WITH (UPDLOCK, ROWLOCK)
         WHERE TenantId IN (${placeholders})`,
        params,
      );
      const byId = new Map(rows.map((row) => [row.TenantId as number, row]));
      const correlationId = ledger.newCorrelationId();
      for (const tenantId of tenantIds) {
        const row = byId.get(tenantId);
        const skip = skipReason(row, today);
        if (skip || !row) {
          skipped.push({ reason: skip ?? "not_found", tenantId });
          continue;
        }
        const expiry = sqlDateToIso(row.Expiry) as string;
        await executeQuery(
          connection,
          `UPDATE dbo.Tenants SET Status = 'current',
             UpdatedAt = SYSUTCDATETIME(), UpdatedById = @UpdatedById, UpdatedByName = @UpdatedByName
           WHERE TenantId = @TenantId AND Status = 'holdover'`,
          [
            { name: "TenantId", type: TYPES.Int, value: tenantId },
            { name: "UpdatedById", type: TYPES.NVarChar, value: oidFromToken(token) ?? "unknown" },
            { name: "UpdatedByName", type: TYPES.NVarChar, value: actor.name },
          ],
        );
        const buildingId = row.BuildingId as number;
        await ledger.record(connection, {
          action: "tenancy.holdover_reset",
          actor,
          after: { status: "current" },
          before: { expiry, status: "holdover" },
          buildingId,
          correlationId,
          reason,
          subject: { id: tenantId, type: "tenancy" },
          tenantId,
        });
        reset.push({ buildingId, expiry, legalName: row.LegalName as string, tenantId });
      }
      await commitTransaction(connection);
    } catch (err) {
      await rollbackQuietly(connection);
      throw err;
    }

    for (const row of reset) invalidateTenantAndBuilding(row.tenantId, row.buildingId);
    context.log(`applyHoldoverReset: ${reset.length} of ${tenantIds.length} reset to current, ${skipped.length} skipped`);
    return { status: 200, jsonBody: { asOf: today, reset, skipped } };
  } catch (error: unknown) {
    const refusal = ledgerRefusal(error);
    if (refusal) return refusal;
    const message = error instanceof Error ? error.message : String(error);
    context.error("applyHoldoverReset failed:", message);
    return errorResponse("Failed to reset stored holdover", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("applyHoldoverReset", {
  authLevel: "anonymous",
  handler: applyHoldoverReset,
  methods: ["POST"],
});
