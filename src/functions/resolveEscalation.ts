// POST /api/resolveEscalation   Body { escalationId, rowVersion, resolutionCode?, note? }
//
// A person ends an attention escalation (stalled, late, unassigned...).
//   resolutionCode  action_taken (default) | no_action_needed | other
//   note            optional, at most 2000 characters
// The raiser is told by email if a person raised it.
//
// Authority escalations (an approval waiting on a decision) are refused with
// 422 { code: "authority_resolve", error, deepLink, subjectType, subjectId }: they
// end when the decision is made on the subject, and `deepLink` is where to go.
//
// 200 { escalation: EscalationDto }
// 403 not one of the people it goes to (or director/admin); 404; 409 as acknowledgeEscalation
//
// Gate: ESCALATION_ROLES (frontend capability viewEscalations), then
// permissions.canAct on the row.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { closeConnection, createRequestConnection } from "../db";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import "../escalation/adapters";
import { toDto } from "../escalation/dto";
import { resolve } from "../escalation/engine";
import {
  ESCALATION_ROLES,
  escalationErrorResponse,
  loadVisibleRow,
  readBody,
  readEscalationId,
  readOptionalText,
  readRowVersion,
  resolveCaller,
  type Caller,
} from "../escalation/http";
import { assertCan, canAct } from "../escalation/permissions";
import { listActiveUsers } from "../escalation/store";
import { NOTE_MAX_CHARS, type DirectoryUser } from "../escalation/types";

export async function resolveEscalation(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
    const resolutionCode = typeof body.resolutionCode === "string" ? body.resolutionCode : undefined;

    connection = await createRequestConnection(token);
    caller = await resolveCaller(request, connection);
    if (!caller) return unauthorizedResponse();

    const loaded = await loadVisibleRow(connection, caller, escalationId);
    directory = loaded.directory;
    assertCan(canAct(caller.viewer, loaded.row), "Only the people this goes to can resolve it.");

    const escalation = await resolve(connection, {
      actor: caller.actor,
      escalationId,
      expectedRowVersion: rowVersion,
      note,
      notify: { attempts: 1 },
      resolutionCode,
    });
    return { jsonBody: { escalation: toDto(escalation, caller.viewer, new Date(), await listActiveUsers(connection)) }, status: 200 };
  } catch (error: unknown) {
    return escalationErrorResponse(error, context, "resolveEscalation", caller ?? undefined, directory);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("resolveEscalation", { methods: ["POST"], authLevel: "anonymous", handler: resolveEscalation });
