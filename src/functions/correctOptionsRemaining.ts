// POST /api/correctOptionsRemaining   (data recheck S2; WP32)
//
//   { tenantId, optionsRemaining, expectedRemaining, reason }
//   200 { optionsRemaining, optionsTotal }
//
// A director corrects how many options a lease has left (Tenants.OptionsRemaining,
// migration 106), within 0..OptionsTotal, with a reason. An option text edit can
// only lower the count (it never gives back an exercised option), so an
// understated count, such as a renewal recorded with 0 options by mistake, would
// otherwise refuse a valid exercise for good.
//
//   expectedRemaining  the count the director saw (null when none was recorded);
//                      a different count now is 409 { code: "stale", current }
//   optionsRemaining   a whole number from 0 to OptionsTotal (400); a lease whose
//                      grant isn't recorded is 422 no_options (set the option
//                      periods first); the same count is 400
//   reason             required (400)
//   role               director; admin only on a test tenancy (decision 4); anyone
//                      else 403, ledgered as denied
// One transaction under an update lock on the tenancy; ledgered as
// schedule.terms_edit (options_remaining_corrected) with the reason, before and after.
//
// Gate: LEASE_DIRECTOR_ROLES (listed under rejectOptionNotice in action-roles: the
// directors' lease option decisions; frontend capability rejectOptionNotice).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { extractToken, oidFromToken, requireRole, unauthorizedResponse } from "../auth";
import { closeConnection, createRequestConnection, executeQuery } from "../db";
import * as ledger from "../ledger";
import { holdsAdmin } from "../moneyRules";
import { resolveCaller } from "../rentReview/http";
import { inTransaction } from "../rentReview/store";
import { invalidateTenantAndBuilding } from "../tenant-register-cache";
import { refuseClosedTenancy } from "../leaseEvents/apply";
import {
  adminOnTestOnly,
  isDirector,
  LEASE_DIRECTOR_ROLES,
  LeaseEventError,
  leaseEventErrorResponse,
  readBody,
  readReason,
  readTenantId,
  recordLeaseEventRefusal,
} from "../leaseEvents/http";
import { lockTenancyForEvent } from "../leaseEvents/store";

const count = (value: unknown, field: string, allowNull: boolean): number | null => {
  if (allowNull && value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 20) {
    throw new LeaseEventError("bad_request", `${field} must be a whole number from 0 to 20`);
  }
  return value;
};

export async function correctOptionsRemaining(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, LEASE_DIRECTOR_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const body = await readBody(request);
    const tenantId = readTenantId(body.tenantId);
    const wanted = count(body.optionsRemaining, "optionsRemaining", false) as number;
    if (!Object.prototype.hasOwnProperty.call(body, "expectedRemaining")) {
      throw new LeaseEventError("bad_request", "expectedRemaining is required: send the count you were shown");
    }
    const expected = count(body.expectedRemaining, "expectedRemaining", true);
    const reason = readReason(body.reason, "Say why the options left are corrected (a reason is required)");

    connection = await createRequestConnection(token);
    const caller = await resolveCaller(request, connection);
    if (!caller) return unauthorizedResponse();
    const db = connection;

    let done;
    try {
      done = await inTransaction(db, async () => {
        const probe = await executeQuery(db, "SELECT COL_LENGTH('dbo.Tenants', 'OptionsRemaining') AS Len");
        if (probe[0]?.Len == null) throw new LeaseEventError("no_options", "Options aren't recorded on this database yet.");
        const tenancy = await lockTenancyForEvent(db, tenantId);
        if (!tenancy) throw new LeaseEventError("not_found", "That tenancy doesn't exist");
        refuseClosedTenancy(tenancy);
        const buildingId = tenancy.BuildingId === null || tenancy.BuildingId === undefined ? null : Number(tenancy.BuildingId);
        const ref = { buildingId, leaseEventId: String(tenantId), state: "options", tenantId };
        const refused = adminOnTestOnly(caller, tenancy.IsTest === true || tenancy.IsTest === 1, ref, "tenancy.options_correct");
        if (refused) throw refused;
        if (!isDirector(caller.roles) && !holdsAdmin(caller.roles)) throw new LeaseEventError("forbidden", "Only a director can correct the options left");
        const total = tenancy.OptionsTotal === null || tenancy.OptionsTotal === undefined ? null : Number(tenancy.OptionsTotal);
        const current = tenancy.OptionsRemaining === null || tenancy.OptionsRemaining === undefined ? null : Number(tenancy.OptionsRemaining);
        if (current !== expected) {
          throw new LeaseEventError("stale", "Someone else changed the options left since you opened this. Reload to see the count now.", { current });
        }
        if (total === null) throw new LeaseEventError("no_options", "This lease's options aren't recorded. Set the option periods on the tenancy first.");
        if (wanted > total) throw new LeaseEventError("bad_request", `Options left can't be more than the lease grants (${total}).`);
        if (wanted === current) throw new LeaseEventError("bad_request", "That is already the count; nothing would change.");
        await executeQuery(
          db,
          `UPDATE dbo.Tenants SET OptionsRemaining = @OptionsRemaining,
             UpdatedAt = SYSUTCDATETIME(), UpdatedById = @UpdatedById, UpdatedByName = @UpdatedByName
           WHERE TenantId = @TenantId`,
          [
            { name: "OptionsRemaining", type: TYPES.Int, value: wanted },
            { name: "UpdatedById", type: TYPES.NVarChar, value: oidFromToken(token) ?? "unknown" },
            { name: "UpdatedByName", type: TYPES.NVarChar, value: caller.actor.name },
            { name: "TenantId", type: TYPES.Int, value: tenantId },
          ],
        );
        await ledger.record(db, {
          action: "schedule.terms_edit",
          actor: caller.actor,
          after: { optionsRemaining: wanted, optionsTotal: total },
          before: { optionsRemaining: current, optionsTotal: total },
          buildingId,
          correlationId: ledger.newCorrelationId(),
          reason,
          ruleApplied: "options_remaining_corrected",
          subject: { id: tenantId, type: "tenancy" },
          tenantId,
        });
        return { buildingId, total };
      });
    } catch (error) {
      await recordLeaseEventRefusal(db, error);
      throw error;
    }
    if (done.buildingId !== null) invalidateTenantAndBuilding(tenantId, done.buildingId);
    return { jsonBody: { optionsRemaining: wanted, optionsTotal: done.total }, status: 200 };
  } catch (error) {
    return leaseEventErrorResponse(error, context, "correctOptionsRemaining");
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("correctOptionsRemaining", { authLevel: "anonymous", handler: correctOptionsRemaining, methods: ["POST"] });
