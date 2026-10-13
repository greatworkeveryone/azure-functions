// POST /api/withdrawEscalation   Body { escalationId, rowVersion, reason }
//
// The person who raised an escalation takes it back, while nobody has
// acknowledged it. `reason` is required (it goes in the decision ledger as an
// exception). Admin can withdraw any open escalation.
//
// 200 { escalation: EscalationDto }
// 400 no reason; 403 not the raiser; 404; 409 someone else changed it, or it was
//   acknowledged or closed meanwhile (the body carries `current`)
//
// Gate: ESCALATION_ROLES (frontend capability viewEscalations), then
// permissions.canWithdraw on the row.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { closeConnection, createRequestConnection } from "../db";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import "../escalation/adapters";
import { toDto } from "../escalation/dto";
import { withdraw } from "../escalation/engine";
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
import { assertCan, canWithdraw } from "../escalation/permissions";
import { listActiveUsers } from "../escalation/store";
import { NOTE_MAX_CHARS, type DirectoryUser } from "../escalation/types";

export async function withdrawEscalation(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
    const reason = readOptionalText(body.reason, "reason", NOTE_MAX_CHARS);

    connection = await createRequestConnection(token);
    caller = await resolveCaller(request, connection);
    if (!caller) return unauthorizedResponse();

    const loaded = await loadVisibleRow(connection, caller, escalationId);
    directory = loaded.directory;
    assertCan(canWithdraw(caller.viewer, loaded.row), "Only the person who raised this can withdraw it.");

    const escalation = await withdraw(connection, { actor: caller.actor, escalationId, expectedRowVersion: rowVersion, reason });
    return { jsonBody: { escalation: toDto(escalation, caller.viewer, new Date(), await listActiveUsers(connection)) }, status: 200 };
  } catch (error: unknown) {
    return escalationErrorResponse(error, context, "withdrawEscalation", caller ?? undefined, directory);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("withdrawEscalation", { methods: ["POST"], authLevel: "anonymous", handler: withdrawEscalation });
