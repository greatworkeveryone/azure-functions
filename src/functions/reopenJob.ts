// POST /api/reopenJob — Body: { JobID, Reason }. The actor is the verified caller.
//
// Done is final (beta sprint J2): a done job comes back only through this
// explicit manager action, with a reason, ledgered as job.reopen (an
// exception). It lands on (Awaiting Approval, accounts), or (Work, facilities)
// for an internal job. The job row is read and locked inside the transaction,
// the guard decides on it, and the write is predicated on it still being Done.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { AppRole, errorResponse, extractToken, requireRole, rolesForRequest, unauthorizedResponse, verifiedIdentityFromRequest } from "../auth";
import { beginTransaction, closeConnection, commitTransaction, createRequestConnection, executeQuery, rollbackTransaction } from "../db";
import { guardTransition } from "../jobTransitionGuard";
import { loadJobForTransition } from "../jobTransitionFacts";
import { record } from "../ledger";
import { resolveLedgerActor } from "../ledger/actor";
import { recordRefusal, recordRoleRefusal, type RefusalTarget } from "../ledger/refusals";

const REOPEN_TARGET: RefusalTarget = { attempted: "job.reopen", idField: "JobID", subjectType: "job" };
const REASON_MAX = 1000;

/** The gate; the guard (REOPEN_ROLES) has the last word, and refuses admin. */
const REOPEN_GATE = [AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS_APPROVAL, AppRole.CFO, AppRole.DIRECTOR] as const;

export async function reopenJob(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, REOPEN_GATE);
  if (denied) {
    await recordRoleRefusal(request, token, denied, REOPEN_TARGET);
    return denied;
  }
  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  let connection;
  try {
    const body = ((await request.json()) ?? {}) as { JobID?: unknown; Reason?: unknown };
    if (typeof body.JobID !== "number") return { status: 400, jsonBody: { error: "JobID (number) required" } };
    if (body.Reason !== undefined && typeof body.Reason !== "string") return { status: 400, jsonBody: { error: "Reason must be text" } };
    const jobId = body.JobID;
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
        request: { kind: "reopen", reason },
      });
      if (!decision.allowed) {
        await rollbackTransaction(connection).catch(() => {});
        await recordRefusal(connection, actor, { id: jobId, type: "job" }, {
          attempted: "job.reopen",
          code: decision.code,
          message: decision.reason,
          state: { status: locked.current.status },
        }, jobId);
        return { status: decision.code === "role_not_permitted" ? 403 : 422, jsonBody: { code: decision.code, error: decision.reason } };
      }

      const to = decision.to;
      await executeQuery(
        connection,
        `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, NewStatus, NewAwaitingRole)
         VALUES (@JobID, @CreatedBy, @Text, @EventType, @NewStatus, @NewAwaitingRole);`,
        [
          { name: "JobID", type: TYPES.Int, value: jobId },
          { name: "CreatedBy", type: TYPES.NVarChar, value: identity.name },
          { name: "Text", type: TYPES.NVarChar, value: `Reopened: ${reason}` },
          { name: "EventType", type: TYPES.NVarChar, value: "job_reopened" },
          { name: "NewStatus", type: TYPES.NVarChar, value: to.status },
          { name: "NewAwaitingRole", type: TYPES.NVarChar, value: to.awaitingRole },
        ],
      );
      const moved = await executeQuery(
        connection,
        `UPDATE Jobs SET Status = @Status, AwaitingRole = @AwaitingRole, LastModifiedDate = SYSUTCDATETIME(),
                StatusSince = SYSUTCDATETIME(), AcknowledgedAt = NULL, AcknowledgedBy = NULL, EscalatedAt = NULL
         OUTPUT INSERTED.JobID
         WHERE JobID = @JobID AND Status = @ExpectedStatus`,
        [
          { name: "JobID", type: TYPES.Int, value: jobId },
          { name: "Status", type: TYPES.NVarChar, value: to.status },
          { name: "AwaitingRole", type: TYPES.NVarChar, value: to.awaitingRole },
          { name: "ExpectedStatus", type: TYPES.NVarChar, value: locked.current.status },
        ],
      );
      if (moved.length === 0) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 409, jsonBody: { code: "job_changed", error: "This job changed while you were saving. Reload it and try again." } };
      }
      await record(connection, {
        action: "job.reopen",
        actor,
        after: { awaitingRole: to.awaitingRole, status: to.status },
        before: { awaitingRole: locked.current.awaitingRole, status: locked.current.status },
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
    const message = error instanceof Error ? error.message : String(error);
    context.error("reopenJob failed:", message);
    return errorResponse("Reopen job failed", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("reopenJob", { methods: ["POST"], authLevel: "anonymous", handler: reopenJob });
