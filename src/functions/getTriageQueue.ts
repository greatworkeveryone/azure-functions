// GET /api/getTriageQueue
//
// The emails waiting for a manager to say who should have them: weak matches the inbound triage
// could not assign by itself, oldest first, up to 50, each with its top three suggestions. A
// manager sees their own team's work and the work either team may take; admin, directors and the
// CFO see all of it (lanesFor). Test emails appear only with an admin's Show test data on. Roles:
// ACTION_ROLES.triageIncomingEmail.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { authorizeWrite } from "../assetRegisterSupport";
import { errorResponse, rolesForRequest } from "../auth";
import { closeConnection, createRequestConnection } from "../db";
import { READ_LIMIT, tooManyRequests } from "../inboundTriage/limits";
import { lanesFor, loadQueue } from "../inboundTriage/routingView";
import { checkRateLimit } from "../rateLimit";
import { showTestParam } from "../test-data";

export async function getTriageQueue(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, ACTION_ROLES.triageIncomingEmail.gate);
  if (!auth.ok) return auth.response;
  const limited = checkRateLimit(`getTriageQueue:${auth.caller.oid}`, READ_LIMIT);
  if (!limited.allowed) return tooManyRequests(limited.retryAfterMs);

  let connection: Connection | undefined;
  try {
    const roles = await rolesForRequest(request);
    const showTest = await showTestParam(request);
    connection = await createRequestConnection(auth.token);
    const items = await loadQueue(connection, lanesFor(roles), showTest.value === true);
    return { headers: { "Cache-Control": "no-store" }, jsonBody: { items }, status: 200 };
  } catch (error) {
    context.error("getTriageQueue failed:", error instanceof Error ? error.message : error);
    return errorResponse("Could not load the triage queue", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getTriageQueue", { authLevel: "anonymous", handler: getTriageQueue, methods: ["GET"] });
