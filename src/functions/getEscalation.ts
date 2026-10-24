// GET /api/getEscalation?escalationId=123
//
// One escalation and its chain: every escalation for the same subject and policy,
// oldest first (the rows it superseded, the rows that superseded it). 404 when it
// doesn't exist or the caller may not see it.
//
// 200 { escalation: EscalationDto, chain: EscalationDto[], next: { roleLabel, names[] } | null }
//
// `next` is who "Escalate further" would send it to. It is null when the ladder
// has nobody above, and also for a caller who can't take that action, so a name
// is only sent to someone who may act on it. Read-only: nothing is written.
//
// Gate: ESCALATION_ROLES (frontend capability viewEscalations).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { closeConnection, createRequestConnection } from "../db";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import "../escalation/adapters";
import { toDto } from "../escalation/dto";
import { previewNextLevel } from "../escalation/engine";
import {
  ESCALATION_ROLES,
  escalationErrorResponse,
  loadVisibleRow,
  readEscalationId,
  resolveCaller,
  type Caller,
} from "../escalation/http";
import { availableActions } from "../escalation/permissions";
import { listChain } from "../escalation/store";

export async function getEscalation(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roleCheck = await requireRole(request, ESCALATION_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  let caller: Caller | null = null;
  try {
    const escalationId = readEscalationId(request.query.get("escalationId")?.trim());
    connection = await createRequestConnection(token);
    caller = await resolveCaller(request, connection);
    if (!caller) return unauthorizedResponse();

    const { directory, row } = await loadVisibleRow(connection, caller, escalationId);
    const now = new Date();
    const chain = await listChain(connection, row);
    const next = availableActions(caller.viewer, row).escalateFurther ? await previewNextLevel(connection, row, now, directory) : null;
    return {
      status: 200,
      jsonBody: {
        chain: chain.map((link) => toDto(link, caller!.viewer, now, directory)),
        escalation: toDto(row, caller.viewer, now, directory),
        next,
      },
    };
  } catch (error: unknown) {
    return escalationErrorResponse(error, context, "getEscalation", caller ?? undefined);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getEscalation", { methods: ["GET"], authLevel: "anonymous", handler: getEscalation });
