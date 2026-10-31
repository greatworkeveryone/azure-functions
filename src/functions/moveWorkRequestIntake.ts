// POST /api/moveWorkRequestIntake  { workRequestId, to: "assessing" | "closed_duplicate" | "closed_not_ours", reason? }
//
// The intake steps that send nothing (TR1, PLAN §15): an acknowledged request goes on to Assessing, and any open
// request can be closed as a duplicate or not ours, with a reason in plain words. Acknowledging is its own route
// (acknowledgeWorkRequest) because it tells the tenant. The move is guarded by the state the caller saw, so two
// people clicking at once cannot both win, and every move is ledgered. ACTION_ROLES.moveRequestIntake.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES, type Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { inTransaction, readJsonBody, txOk } from "../assetRegisterSupport";
import { errorResponse } from "../auth";
import { authorizeActor, badRequest, conflict, noStore, notFound } from "../comms/actor";
import { unexpectedKey } from "../comms/request";
import { findUserByOid } from "../comms/userSignatureStore";
import { closeConnection, createRequestConnection, executeQuery } from "../db";
import { isFeatureEnabledForRoles } from "../features/flags";
import { canMove, isClosed, isIntakeState, MAX_CLOSE_REASON_CHARS, storedState, type IntakeState } from "../intake/state";
import { record } from "../ledger";
import { ledgerUserActor } from "../ledger/actor";
import { checkRateLimit } from "../rateLimit";
import { parseWorkRequestId } from "../workRequestsNative";

const TARGETS: readonly IntakeState[] = ["assessing", "closed_duplicate", "closed_not_ours"];

export async function moveWorkRequestIntake(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeActor(request, ACTION_ROLES.moveRequestIntake.gate);
  if (!auth.ok) return auth.response;
  const { actor } = auth;
  const limited = checkRateLimit(`moveWorkRequestIntake:${actor.oid}`, { limit: 60 });
  if (!limited.allowed) return { headers: { "Retry-After": String(Math.ceil(limited.retryAfterMs / 1000)) }, jsonBody: { error: "Too many changes, try again shortly" }, status: 429 };
  const body = await readJsonBody(request);
  if (!body) return badRequest("JSON object required");
  const extra = unexpectedKey(body, ["workRequestId", "to", "reason"]);
  if (extra) return badRequest(extra);
  const id = typeof body.workRequestId === "number" ? parseWorkRequestId(body.workRequestId) : null;
  if (id === null) return badRequest("workRequestId must be a whole number");
  const to = body.to;
  if (!isIntakeState(to) || !TARGETS.includes(to)) return badRequest("to must be assessing, closed_duplicate or closed_not_ours");
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length > MAX_CLOSE_REASON_CHARS) return badRequest(`The reason is too long (over ${MAX_CLOSE_REASON_CHARS} characters)`);
  if (isClosed(to) && reason === "") return badRequest("Say why it is being closed");

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    if (!(await isFeatureEnabledForRoles("tenantRequests", actor.roles, { connection }))) return notFound("Not available");
    const row = (
      await executeQuery(
        connection,
        `SELECT wr.IntakeState, wr.BuildingID, CASE WHEN EXISTS (SELECT 1 FROM dbo.Jobs j WHERE j.WorkRequestID = wr.WorkRequestID) THEN 1 ELSE 0 END AS HasJob
           FROM dbo.WorkRequests wr WHERE wr.WorkRequestID = @Id`,
        [{ name: "Id", type: TYPES.Int, value: id }],
      )
    )[0];
    if (!row) return notFound("No such request");
    if (Number(row.HasJob) === 1) return conflict("A job has already been raised from this request");
    const from = storedState(row.IntakeState);
    if (!canMove(from, to)) return conflict(isClosed(from) ? "This request has been closed" : to === "assessing" ? "Acknowledge the request before assessing it" : "That move isn't allowed from here");

    const user = await findUserByOid(connection, actor.oid);
    const moved = await inTransaction<boolean>(connection, async () => {
      const done = await executeQuery(
        connection as Connection,
        `UPDATE dbo.WorkRequests
            SET IntakeState = @To, IntakeClosedReason = @Reason, IntakeUpdatedAt = SYSUTCDATETIME()
         OUTPUT inserted.WorkRequestID
          WHERE WorkRequestID = @Id AND ISNULL(IntakeState, N'received') = @From`,
        [
          { name: "To", type: TYPES.NVarChar, value: to },
          { name: "Reason", type: TYPES.NVarChar, value: isClosed(to) ? reason : null },
          { name: "Id", type: TYPES.Int, value: id },
          { name: "From", type: TYPES.NVarChar, value: from },
        ],
      );
      if (done.length === 0) return txOk(false);
      await record(connection as Connection, {
        action: isClosed(to) ? "work_request.close" : "work_request.assess",
        actor: ledgerUserActor({ name: actor.name, roles: actor.roles, userId: user?.userId ?? null }),
        after: { intakeState: to },
        before: { intakeState: from },
        buildingId: row.BuildingID === null || row.BuildingID === undefined ? null : Number(row.BuildingID),
        reason: isClosed(to) ? reason : null,
        subject: { id, type: "work_request" },
      });
      return txOk(true);
    });
    if (!moved.ok || !moved.value) return conflict("Someone else changed this request just now");
    return { headers: noStore, jsonBody: { state: to, workRequestId: id }, status: 200 };
  } catch (error) {
    context.error("moveWorkRequestIntake failed:", error instanceof Error ? error.message : error);
    return errorResponse("Could not change the request", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("moveWorkRequestIntake", { authLevel: "anonymous", handler: moveWorkRequestIntake, methods: ["POST"] });
