// POST /api/recomputeNextReviewDates — admin only (PLAN WP23b, D1). Run once
// after deploy: NextReviewDate was hand-maintained (and drifted off the lease
// anniversary); it is now derived from the schedule (deriveNextReviewDate).
//
//   {}                         dry run — lists every change, with a planId
//   { apply: true, planId }    changes exactly the rows that dry run listed, in
//                              one transaction, one schedule.recompute_next_review
//                              ledger row per changed tenancy under one
//                              CorrelationId. If anything moved since the dry
//                              run the plan no longer matches: 409, nothing
//                              written, and the new list to review.
//
// Vacated tenancies are left alone (their review state is grey). A tenancy
// with nothing to derive from (no schedule, a date already set) keeps its date.

import { createHash } from "node:crypto";
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { Connection, TYPES } from "tedious";
import {
  AppRole,
  errorResponse,
  extractToken,
  nameFromToken,
  oidFromToken,
  requireRole,
  unauthorizedResponse,
} from "../auth";
import { todayInDarwin } from "../darwinDate";
import {
  beginTransaction,
  closeConnection,
  commitTransaction,
  createRequestConnection,
  executeQuery,
} from "../db";
import * as ledger from "../ledger";
import { ledgerActorFor } from "../ledgerActor";
import { deriveNextReviewDate, nextReviewInputFromRow, RESOLVED_REVIEW_DATES_SQL } from "../nextReviewDate";
import { parseSteps } from "../scheduledRateStepLogic";
import { invalidateTenantAndBuilding } from "../tenant-register-cache";
import { rollbackQuietly } from "../tenancyScheduleWrite";

interface NextReviewChange {
  buildingId: number;
  from: string | null;
  legalName: string;
  tenantId: number;
  to: string;
}

interface RecomputePlan {
  changes: NextReviewChange[];
  /** Tenancies with nothing to derive from; their stored date stays. */
  notDerivable: number;
  planId: string;
  unchanged: number;
}

const TENANCY_COLUMNS = `
  TenantId, BuildingId, LegalName,
  Commencement, LastReviewDate, ReviewIntervalMonths, NextReviewDate, ScheduledRateSteps,
  ${RESOLVED_REVIEW_DATES_SQL}
`;

const PLAN_SQL = `SELECT ${TENANCY_COLUMNS} FROM dbo.Tenants t
  WHERE t.Status <> 'vacated' ORDER BY t.TenantId`;
const PLAN_SQL_LOCKED = `SELECT ${TENANCY_COLUMNS} FROM dbo.Tenants t WITH (UPDLOCK, ROWLOCK)
  WHERE t.Status <> 'vacated' ORDER BY t.TenantId`;

async function computePlan(connection: Connection, lock: boolean): Promise<RecomputePlan> {
  const rows = await executeQuery(connection, lock ? PLAN_SQL_LOCKED : PLAN_SQL);
  const changes: NextReviewChange[] = [];
  let notDerivable = 0;
  for (const row of rows) {
    const input = nextReviewInputFromRow(row, parseSteps(row.ScheduledRateSteps as string | null | undefined));
    const derived = deriveNextReviewDate(input);
    if (derived === null) notDerivable++;
    else if (derived !== input.storedNextReviewDate) {
      changes.push({
        buildingId: row.BuildingId as number,
        from: input.storedNextReviewDate,
        legalName: row.LegalName as string,
        tenantId: row.TenantId as number,
        to: derived,
      });
    }
  }
  const planId = createHash("sha256")
    .update(JSON.stringify(changes.map((change) => [change.tenantId, change.from, change.to])))
    .digest("hex")
    .slice(0, 32);
  return { changes, notDerivable, planId, unchanged: rows.length - changes.length - notDerivable };
}

async function applyPlan(
  connection: Connection,
  actor: ledger.LedgerActor,
  callerId: string,
  planId: string,
): Promise<HttpResponseInit> {
  await beginTransaction(connection);
  try {
    const plan = await computePlan(connection, true);
    if (plan.planId !== planId) {
      await rollbackQuietly(connection);
      return {
        status: 409,
        jsonBody: {
          ...plan,
          error: "Tenancies changed since the dry run, so nothing was written. Review this new list and apply its planId.",
        },
      };
    }
    const correlationId = ledger.newCorrelationId();
    for (const change of plan.changes) {
      await executeQuery(
        connection,
        `UPDATE dbo.Tenants SET NextReviewDate = @To,
           UpdatedAt = SYSUTCDATETIME(), UpdatedById = @UpdatedById, UpdatedByName = @UpdatedByName
         WHERE TenantId = @TenantId`,
        [
          { name: "To", type: TYPES.Date, value: change.to },
          { name: "UpdatedById", type: TYPES.NVarChar, value: callerId },
          { name: "UpdatedByName", type: TYPES.NVarChar, value: actor.name },
          { name: "TenantId", type: TYPES.Int, value: change.tenantId },
        ],
      );
      await ledger.record(connection, {
        action: "schedule.recompute_next_review",
        actor,
        after: { nextReviewDate: change.to },
        before: { nextReviewDate: change.from },
        buildingId: change.buildingId,
        correlationId,
        ruleApplied: "recompute_one_off",
        subject: { id: change.tenantId, type: "tenancy" },
        tenantId: change.tenantId,
      });
    }
    await commitTransaction(connection);
    for (const change of plan.changes) invalidateTenantAndBuilding(change.tenantId, change.buildingId);
    return { status: 200, jsonBody: { applied: plan.changes.length, changes: plan.changes, correlationId } };
  } catch (err) {
    await rollbackQuietly(connection);
    throw err;
  }
}

export async function recomputeNextReviewDates(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, [AppRole.ADMIN]);
  if (roleCheck) return roleCheck;

  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // No body: a dry run.
  }
  const apply = body.apply === true;
  if (apply && (typeof body.planId !== "string" || body.planId === "")) {
    return { status: 400, jsonBody: { error: "Applying needs the planId from a dry run" } };
  }

  let connection;
  try {
    connection = await createRequestConnection(token);
    if (!apply) {
      const plan = await computePlan(connection, false);
      return { status: 200, jsonBody: { ...plan, asOf: todayInDarwin(), dryRun: true } };
    }
    const caller = { id: oidFromToken(token) ?? "unknown", name: nameFromToken(token) ?? "Unknown user" };
    const actor = await ledgerActorFor(request, connection, caller);
    return await applyPlan(connection, actor, caller.id, body.planId as string);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("recomputeNextReviewDates failed:", message);
    return errorResponse("Failed to recompute next review dates", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("recomputeNextReviewDates", {
  authLevel: "anonymous",
  handler: recomputeNextReviewDates,
  methods: ["POST"],
});
