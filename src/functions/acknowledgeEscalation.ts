// POST /api/acknowledgeEscalation   Body { escalationId, rowVersion }
//
// The target claims an open escalation: it becomes theirs (TargetUserId), SLA
// re-escalation for that level stops, and the subject's escalated flag on the
// dashboard clears (Jobs.EscalatedAt). Acknowledging again as the same person is
// a no-op.
//
// 200 { escalation: EscalationDto }
// 403 not one of the people it goes to (or director/admin); the raiser never can
// 404 not found or not visible; 409 someone else changed it / already acknowledged
//   by someone else / no longer open (the body carries `current`)
//
// Gate: ESCALATION_ROLES (frontend capability viewEscalations), then
// permissions.canAct on the row.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { closeConnection, createRequestConnection } from "../db";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import "../escalation/adapters";
import { toDto } from "../escalation/dto";
import { acknowledge } from "../escalation/engine";
import {
  ESCALATION_ROLES,
  escalationErrorResponse,
  loadVisibleRow,
  readBody,
  readEscalationId,
  readRowVersion,
  resolveCaller,
  type Caller,
} from "../escalation/http";
import { assertCan, canAct } from "../escalation/permissions";
import { listActiveUsers } from "../escalation/store";
import type { DirectoryUser } from "../escalation/types";

export async function acknowledgeEscalation(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roleCheck = await requireRole(request, ESCALATION_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  let caller: Caller | null = null;
  let directory: DirectoryUser[] = [];
  try {
    const body = await readBody(request);
    const escalationId = readEscalationId(body.escalationId);
    const rowVersion = readRowVersion(body);

    connection = await createRequestConnection(token);
    caller = await resolveCaller(request, connection);
    if (!caller) return unauthorizedResponse();

    const loaded = await loadVisibleRow(connection, caller, escalationId);
    directory = loaded.directory;
    assertCan(canAct(caller.viewer, loaded.row), "Only the people this goes to can acknowledge it.");

    const escalation = await acknowledge(connection, { actor: caller.actor, escalationId, expectedRowVersion: rowVersion });
    return { jsonBody: { escalation: toDto(escalation, caller.viewer, new Date(), await listActiveUsers(connection)) }, status: 200 };
  } catch (error: unknown) {
    return escalationErrorResponse(error, context, "acknowledgeEscalation", caller ?? undefined, directory);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("acknowledgeEscalation", { methods: ["POST"], authLevel: "anonymous", handler: acknowledgeEscalation });
