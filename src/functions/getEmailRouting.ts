// GET /api/getEmailRouting?emailIds=1,2,3
//
// Who owns each Incoming email and why: the mailbox it arrived in, the person it is assigned to
// with the plain reasons, the send it replies to, and, for an email waiting for a manager, the top
// three suggestions. Up to 100 ids. Same roles as getEmails (ACTION_ROLES.viewEmailRouting). Behind
// the inboundTriage flag in the app, which calls this only with the flag on; the flag is a rollout
// tool, not a gate here.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { authorizeWrite, badRequest } from "../assetRegisterSupport";
import { errorResponse } from "../auth";
import { closeConnection, createRequestConnection } from "../db";
import { parseEmailIds } from "../inboundTriage/input";
import { READ_LIMIT, tooManyRequests } from "../inboundTriage/limits";
import { loadRouting } from "../inboundTriage/routingView";
import { checkRateLimit } from "../rateLimit";

export async function getEmailRouting(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, ACTION_ROLES.viewEmailRouting.gate);
  if (!auth.ok) return auth.response;
  const limited = checkRateLimit(`getEmailRouting:${auth.caller.oid}`, READ_LIMIT);
  if (!limited.allowed) return tooManyRequests(limited.retryAfterMs);
  const ids = parseEmailIds(request.query.get("emailIds"));
  if (!ids.ok) return badRequest(ids.error);

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const routing = await loadRouting(connection, ids.value);
    return { headers: { "Cache-Control": "no-store" }, jsonBody: { items: [...routing.values()] }, status: 200 };
  } catch (error) {
    context.error("getEmailRouting failed:", error instanceof Error ? error.message : error);
    return errorResponse("Could not load who has these emails", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getEmailRouting", { authLevel: "anonymous", handler: getEmailRouting, methods: ["GET"] });
