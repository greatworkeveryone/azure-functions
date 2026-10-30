// GET /api/getRequestIntake?ids=1,2,3
//
// Intake state of up to 100 work requests (TR1, PLAN §15): received, acknowledged, assessing, converted (a job was
// raised from it) or closed; who acknowledged it, when and how; and, only when Facilities has set a response target for
// its priority and the request is still waiting, the time it is due. Separate from getWorkRequests on purpose: the
// app asks only with the tenantRequests flag on, so Incoming's own list does not change while it is hidden.
// Same roles as read work requests (ACTION_ROLES.viewRequestIntake).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { authorizeWrite, badRequest } from "../assetRegisterSupport";
import { errorResponse } from "../auth";
import { closeConnection, createRequestConnection, executeQuery } from "../db";
import { parseEmailIds } from "../inboundTriage/input";
import { READ_LIMIT, tooManyRequests } from "../inboundTriage/limits";
import { dueAtFor } from "../intake/overdue";
import { intakePriority, viewState } from "../intake/state";
import { checkRateLimit } from "../rateLimit";

const iso = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : null);
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

export async function getRequestIntake(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, ACTION_ROLES.viewRequestIntake.gate);
  if (!auth.ok) return auth.response;
  const limited = checkRateLimit(`getRequestIntake:${auth.caller.oid}`, READ_LIMIT);
  if (!limited.allowed) return tooManyRequests(limited.retryAfterMs);
  const ids = parseEmailIds(request.query.get("ids"));
  if (!ids.ok) return badRequest(ids.error.replace(/email/g, "request"));

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    // Ids are whole numbers parsed above, so they are spliced in, not bound.
    const rows = await executeQuery(
      connection,
      `SELECT wr.WorkRequestID, wr.IntakeState, wr.AcknowledgedAt, wr.AcknowledgedBy, wr.AcknowledgedVia, wr.IntakeClosedReason, wr.CreatedAt,
              COALESCE(o.Priority, wr.Priority) AS Priority,
              CASE WHEN EXISTS (SELECT 1 FROM dbo.Jobs j WHERE j.WorkRequestID = wr.WorkRequestID) THEN 1 ELSE 0 END AS HasJob
         FROM dbo.WorkRequests wr
         LEFT JOIN dbo.WorkRequestOverrides o ON o.WorkRequestID = wr.WorkRequestID
        WHERE wr.WorkRequestID IN (${ids.value.join(",")})`,
    );
    const targets = new Map(
      (await executeQuery(connection, "SELECT Priority, AckWithinBusinessHours, SetAt FROM dbo.IntakeResponseTargets")).map((row) => [String(row.Priority), row]),
    );
    const items = rows.map((row) => {
      const state = viewState(row.IntakeState, Number(row.HasJob) === 1);
      const target = targets.get(intakePriority(row.Priority));
      const hours = target?.AckWithinBusinessHours === null || target?.AckWithinBusinessHours === undefined ? null : Number(target.AckWithinBusinessHours);
      const due = state === "received" ? dueAtFor(row.CreatedAt instanceof Date ? row.CreatedAt : null, hours, target?.SetAt instanceof Date ? target.SetAt : null) : null;
      return {
        acknowledgedAt: iso(row.AcknowledgedAt),
        acknowledgedBy: str(row.AcknowledgedBy),
        acknowledgedVia: str(row.AcknowledgedVia),
        closedReason: str(row.IntakeClosedReason),
        dueAt: iso(due),
        state,
        targetHours: due === null ? null : hours,
        workRequestId: Number(row.WorkRequestID),
      };
    });
    return { headers: { "Cache-Control": "no-store" }, jsonBody: { items }, status: 200 };
  } catch (error) {
    context.error("getRequestIntake failed:", error instanceof Error ? error.message : error);
    return errorResponse("Could not load the intake state of these requests", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getRequestIntake", { authLevel: "anonymous", handler: getRequestIntake, methods: ["GET"] });
