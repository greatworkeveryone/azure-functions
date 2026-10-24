// POST /api/resolveBroadcastAudience
//   { tenancies?: { selections: [{ buildingId, levels? }], contacts?: ["primary","accounts"], categories?: ["commercial","residence"] },
//     contractors?: { trades?, buildingIds? }, staff?: { roles }, typed?: [address, ...] }
//
// Who a broadcast would go to, worked out from the register: de-duplicated recipients (one per address, keeping the
// record with the most to merge), the count of each kind, and everyone left out with the reason (no address, not
// an address, test record). Tenancy contacts are active tenancies only (current or holdover, not archived).
// Reads only: nothing is saved or sent. Managers and directors (ACTION_ROLES.sendBroadcast).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { readJsonBody } from "../assetRegisterSupport";
import { errorResponse } from "../auth";
import { authorizeActor, badRequest, noStore } from "../comms/actor";
import { parseAudienceRequest } from "../comms/broadcast/audienceInput";
import { resolveAudience } from "../comms/broadcast/resolveAudience";
import { MAX_RECIPIENTS_PER_JOB } from "../comms/config";
import { closeConnection, createRequestConnection } from "../db";
import { checkRateLimit } from "../rateLimit";

export async function resolveBroadcastAudience(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeActor(request, ACTION_ROLES.sendBroadcast.gate);
  if (!auth.ok) return auth.response;
  const limited = checkRateLimit(`resolveBroadcastAudience:${auth.actor.oid}`, { limit: 60 });
  if (!limited.allowed) return { headers: { "Retry-After": String(Math.ceil(limited.retryAfterMs / 1000)) }, jsonBody: { error: "Too many requests, try again shortly" }, status: 429 };
  const body = await readJsonBody(request);
  if (!body) return badRequest("JSON object required");
  const input = parseAudienceRequest(body);
  if (!input.ok) return badRequest(input.error);

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const audience = await resolveAudience(connection, input.value);
    if (audience.recipients.length > MAX_RECIPIENTS_PER_JOB) {
      return badRequest(`That is ${audience.recipients.length} people. A send can have at most ${MAX_RECIPIENTS_PER_JOB}: choose fewer buildings or levels.`);
    }
    return { headers: noStore, jsonBody: audience, status: 200 };
  } catch (error) {
    context.error("resolveBroadcastAudience failed:", error instanceof Error ? error.message : error);
    return errorResponse("Could not work out who the email is for", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("resolveBroadcastAudience", { authLevel: "anonymous", handler: resolveBroadcastAudience, methods: ["POST"] });
