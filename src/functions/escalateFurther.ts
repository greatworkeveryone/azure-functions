// POST /api/escalateFurther   Body { escalationId, rowVersion, note?, targetUserId? }
//
// Pushes a live escalation up to the next level of its ladder, by hand (the
// sweep does the same when an SLA passes). The old escalation ends as
// superseded; a new one at the next level points back at it
// (ParentEscalationId); both are written to the decision ledger together. The
// people at the new level are emailed and the previous level is told.
//   note          optional, at most 2000 characters
//   targetUserId  optional: a specific person at the next level
//
// 200 { escalation: EscalationDto (the new one), previous: EscalationDto }
// 403 not one of the people it goes to, the raiser, or director/admin
// 404; 409 someone else changed it or it is no longer live (the body carries `current`)
// 422 { code: "no_further_level" } it is already with the top of the ladder, or
//   targetUserId isn't someone at the next level
//
// Gate: ESCALATION_ROLES (frontend capability viewEscalations), then
// permissions.canEscalateFurther on the row.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { closeConnection, createRequestConnection } from "../db";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import "../escalation/adapters";
import { toDto } from "../escalation/dto";
import { escalateFurther as escalateFurtherEngine } from "../escalation/engine";
import {
  ESCALATION_ROLES,
  escalationErrorResponse,
  loadVisibleRow,
  readBody,
  readEscalationId,
  readOptionalText,
  readOptionalUserId,
  readRowVersion,
  resolveCaller,
  type Caller,
} from "../escalation/http";
import { assertCan, canEscalateFurther } from "../escalation/permissions";
import { listActiveUsers } from "../escalation/store";
import { NOTE_MAX_CHARS, type DirectoryUser } from "../escalation/types";

export async function escalateFurther(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
    const note = readOptionalText(body.note, "note", NOTE_MAX_CHARS);
    const preferredUserId = readOptionalUserId(body.targetUserId, "targetUserId");

    connection = await createRequestConnection(token);
    caller = await resolveCaller(request, connection);
    if (!caller) return unauthorizedResponse();

    const loaded = await loadVisibleRow(connection, caller, escalationId);
    directory = loaded.directory;
    assertCan(canEscalateFurther(caller.viewer, loaded.row), "Only the people this goes to, or the person who raised it, can send it further up.");

    const { next, previous } = await escalateFurtherEngine(connection, {
      actor: caller.actor,
      escalationId,
      expectedRowVersion: rowVersion,
      mode: "next_level",
      note,
      notify: { attempts: 1 },
      preferredUserId,
    });
    const now = new Date();
    const users = await listActiveUsers(connection);
    return {
      jsonBody: { escalation: toDto(next, caller.viewer, now, users), previous: toDto(previous, caller.viewer, now, users) },
      status: 200,
    };
  } catch (error: unknown) {
    return escalationErrorResponse(error, context, "escalateFurther", caller ?? undefined, directory);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("escalateFurther", { methods: ["POST"], authLevel: "anonymous", handler: escalateFurther });
