// POST /api/recomputeJobStatus — Body: { JobID, Reason, Preview? }. The actor is the verified caller.
//
// REV-02: the correction for a job whose status no longer matches its records
// (an event was lost, or a hold swallowed one before the held-state fix). A
// manager (the reopen roles) puts it where the records say it is, with a
// reason. The target is worked out by the shared guard from the same facts it
// reads for every other move, so it can never move a job into or out of Done,
// off a hold, or past an approval. Everything is one transaction on the locked
// job: the event, the ledger row (before, after, the facts) and the update.
// With Preview: true nothing is written; the answer is what a save would do.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { errorResponse, extractToken, requireRole, rolesForRequest, unauthorizedResponse, verifiedIdentityFromRequest } from "../auth";
import { ACTION_ROLES } from "../action-roles";
import { beginTransaction, closeConnection, commitTransaction, createRequestConnection, executeQuery, rollbackTransaction } from "../db";
import { derivedState, guardTransition } from "../jobTransitionGuard";
import { loadJobForTransition } from "../jobTransitionFacts";
import { isWorkCompletion, markServiceJobCompleted } from "../serviceScheduleRuns";
import { record } from "../ledger";
import { resolveLedgerActor } from "../ledger/actor";
import { recordRefusal, recordRoleRefusal, type RefusalTarget } from "../ledger/refusals";
import { errorMessage } from "../errorMessage";

const RECOMPUTE_TARGET: RefusalTarget = { attempted: "job.status_recomputed", idField: "JobID", subjectType: "job" };
const REASON_MAX = 1000;

export async function recomputeJobStatus(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, ACTION_ROLES.recomputeJobStatus.gate);
  if (denied) {
    await recordRoleRefusal(request, token, denied, RECOMPUTE_TARGET);
    return denied;
  }
  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  let connection;
  try {
    const body = ((await request.json()) ?? {}) as { JobID?: unknown; Preview?: unknown; Reason?: unknown };
    if (typeof body.JobID !== "number") return { status: 400, jsonBody: { error: "JobID (number) required" } };
    if (body.Reason !== undefined && typeof body.Reason !== "string") return { status: 400, jsonBody: { error: "Reason must be text" } };
    const jobId = body.JobID;
    const preview = body.Preview === true;
    const reason = typeof body.Reason === "string" ? body.Reason.trim().slice(0, REASON_MAX) : "";

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();
    const roles = await rolesForRequest(request);

    await beginTransaction(connection);
    try {
      const locked = await loadJobForTransition(connection, jobId);
      if (!locked) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: "Job not found" } };
      }
      const decision = guardTransition({
        actor: { kind: "user", roles },
        current: locked.current,
        facts: locked.facts,
        machineTarget: null,
        // A preview has no reason yet; the guard's other checks are what it shows.
        request: { kind: "recompute", reason: preview && reason === "" ? "preview" : reason },
      });
      if (preview) {
        await rollbackTransaction(connection).catch(() => {});
        if (!decision.allowed && decision.code !== "status_already_right") {
          return { status: decision.code === "role_not_permitted" ? 403 : 422, jsonBody: { code: decision.code, error: decision.reason } };
        }
        return {
          status: 200,
          jsonBody: { current: locked.current, matches: !decision.allowed, to: decision.allowed ? decision.to : derivedState(locked.facts) },
        };
      }
      if (!decision.allowed) {
        await rollbackTransaction(connection).catch(() => {});
        await recordRefusal(connection, actor, { id: jobId, type: "job" }, {
          attempted: "job.status_recomputed",
          code: decision.code,
          message: decision.reason,
          state: { status: locked.current.status },
        }, jobId);
        return { status: decision.code === "role_not_permitted" ? 403 : 422, jsonBody: { code: decision.code, error: decision.reason } };
      }

      const to = decision.to;
      const from = locked.current;
      const moved = await executeQuery(
        connection,
        `UPDATE Jobs SET Status = @Status, AwaitingRole = @AwaitingRole, LastModifiedDate = SYSUTCDATETIME(),
                StatusSince = SYSUTCDATETIME(), AcknowledgedAt = NULL, AcknowledgedBy = NULL, EscalatedAt = NULL
         OUTPUT INSERTED.JobID
         WHERE JobID = @JobID AND Status = @ExpectedStatus AND AwaitingRole = @ExpectedRole`,
        [
          { name: "JobID", type: TYPES.Int, value: jobId },
          { name: "Status", type: TYPES.NVarChar, value: to.status },
          { name: "AwaitingRole", type: TYPES.NVarChar, value: to.awaitingRole },
          { name: "ExpectedStatus", type: TYPES.NVarChar, value: from.status },
          { name: "ExpectedRole", type: TYPES.NVarChar, value: from.awaitingRole },
        ],
      );
      if (moved.length === 0) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 409, jsonBody: { code: "job_changed", error: "This job changed while you were saving. Reload it and try again." } };
      }
      await executeQuery(
        connection,
        `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, NewStatus, NewAwaitingRole)
         VALUES (@JobID, @CreatedBy, @Text, 'status_corrected', @NewStatus, @NewAwaitingRole);`,
        [
          { name: "JobID", type: TYPES.Int, value: jobId },
          { name: "CreatedBy", type: TYPES.NVarChar, value: identity.name },
          { name: "Text", type: TYPES.NVarChar, value: `Status corrected from ${from.status} to ${to.status}: ${reason}` },
          { name: "NewStatus", type: TYPES.NVarChar, value: to.status },
          { name: "NewAwaitingRole", type: TYPES.NVarChar, value: to.awaitingRole },
        ],
      );
      // Forward into a work completion stamps a scheduled service run, as a
      // real transition does; a move backwards never does.
      if (isWorkCompletion(to.status, to.awaitingRole)) {
        await markServiceJobCompleted(connection, jobId, identity.name);
      }
      await record(connection, {
        action: "job.status_recomputed",
        actor,
        after: { awaitingRole: to.awaitingRole, facts: { ...locked.facts }, status: to.status },
        before: { awaitingRole: from.awaitingRole, status: from.status },
        buildingId: locked.buildingId,
        jobId,
        reason,
        subject: { id: jobId, type: "job" },
      });
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }

    const stored = await executeQuery(
      connection,
      "SELECT JobID, Status, AwaitingRole, StatusSince FROM Jobs WHERE JobID = @JobID",
      [{ name: "JobID", type: TYPES.Int, value: jobId }],
    );
    return { status: 200, jsonBody: { job: stored[0] } };
  } catch (error: unknown) {
    const message = errorMessage(error);
    context.error("recomputeJobStatus failed:", message);
    return errorResponse("Fix job status failed", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("recomputeJobStatus", { methods: ["POST"], authLevel: "anonymous", handler: recomputeJobStatus });
