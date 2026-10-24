// POST /api/assignEmail  { emailId, assigneeUserId, expectedAssigneeUserId, note? }
//
// A manager gives an Incoming email to someone (from the Needs triage queue or by picking a person),
// or moves an assigned email to someone else. The email's owner, a routing-log outcome (accepted, chose
// other, or reassigned) and a ledger row (email.assign or email.reassign) are written in one
// transaction. `expectedAssigneeUserId` is who the screen believed had the email; a different owner now
// is a 409, never an overwrite. Only staff roles can be given mail, and not someone on leave today.
// Roles: ACTION_ROLES.triageIncomingEmail.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { authorizeWrite, badRequest, conflict, notFound, readJsonBody } from "../assetRegisterSupport";
import { errorResponse, unauthorizedResponse } from "../auth";
import { closeConnection, createRequestConnection } from "../db";
import { assignEmail as assign } from "../inboundTriage/assign";
import { parseAssignBody } from "../inboundTriage/input";
import { ASSIGN_LIMIT, tooManyRequests } from "../inboundTriage/limits";
import { loadRouting } from "../inboundTriage/routingView";
import { resolveLedgerActor } from "../ledger/actor";
import { checkRateLimit } from "../rateLimit";

export async function assignEmail(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, ACTION_ROLES.triageIncomingEmail.gate);
  if (!auth.ok) return auth.response;
  const limited = checkRateLimit(`assignEmail:${auth.caller.oid}`, ASSIGN_LIMIT);
  if (!limited.allowed) return tooManyRequests(limited.retryAfterMs);
  const body = await readJsonBody(request);
  if (!body) return badRequest("JSON object required");
  const input = parseAssignBody(body);
  if (!input.ok) return badRequest(input.error);

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const ledger = await resolveLedgerActor(request, connection);
    if (!ledger) return unauthorizedResponse();
    const result = await assign(connection, input.value, { ledger, name: auth.caller.name, oid: auth.caller.oid });
    if (!result.ok) {
      if (result.status === 404) return notFound(result.error);
      return result.status === 409 ? conflict(result.error) : badRequest(result.error);
    }
    const routing = (await loadRouting(connection, [result.value.emailId])).get(result.value.emailId) ?? null;
    return { headers: { "Cache-Control": "no-store" }, jsonBody: { outcome: result.value.outcome, routing }, status: 200 };
  } catch (error) {
    context.error("assignEmail failed:", error instanceof Error ? error.message : error);
    return errorResponse("Could not assign the email", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("assignEmail", { authLevel: "anonymous", handler: assignEmail, methods: ["POST"] });
