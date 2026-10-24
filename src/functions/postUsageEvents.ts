// POST /api/postUsageEvents
//
// The browser's usage beacon (PLAN §14, UA1): a batch of page segments and the active seconds spent
// in them, from the sign-in the token proves. The person is never in the body. Any signed-in role.
//
//   204  stored, or dropped on purpose: tracking is off (USAGE_TRACKING_ENABLED is not "true"), the
//        token's person has no active row, the usageAnalytics flag is not enabled for their role, or the
//        batch named someone else's session
//   400  the batch is malformed (see usage/validate.ts)   413  body too large
//   429  too many batches from this person lately
//
// Nothing here reads or stores what a person typed, page content, record contents or a location.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { AppRole, errorResponse, extractToken, oidFromToken, requireRole, rolesForRequest, unauthorizedResponse } from "../auth";
import { closeConnection, createRequestConnection } from "../db";
import { readCappedBody } from "../usage/body";
import { usageTrackingOn } from "../usage/config";
import { usageFlagEnabledFor } from "../usage/flag";
import { storeUsageBatch, userIdForOid } from "../usage/ingest";
import { allowUsageBatch } from "../usage/rateLimit";
import { MAX_BODY_CHARS, parseUsageBatch } from "../usage/validate";

const NO_CONTENT: HttpResponseInit = { status: 204 };

export async function postUsageEvents(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, [AppRole.USER]);
  if (denied) return denied;
  if (!usageTrackingOn()) return NO_CONTENT;
  const oid = oidFromToken(token);
  if (!oid) return NO_CONTENT;

  const read = await readCappedBody(request, MAX_BODY_CHARS);
  if ("tooLarge" in read) return { jsonBody: { error: "That batch is too large" }, status: 413 };
  const { text } = read;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { jsonBody: { error: "Send JSON" }, status: 400 };
  }
  const parsed = parseUsageBatch(body);
  if ("error" in parsed) return { jsonBody: { error: parsed.error }, status: 400 };

  let connection;
  try {
    connection = await createRequestConnection(token);
    const userId = await userIdForOid(connection, oid);
    if (userId === null) return NO_CONTENT;
    if (!(await usageFlagEnabledFor(connection, await rolesForRequest(request)))) return NO_CONTENT;
    if (!allowUsageBatch(userId)) return { headers: { "Retry-After": "60" }, jsonBody: { error: "Too many usage batches. Try again shortly." }, status: 429 };
    const startedAt = parsed.batch.views.reduce((first, view) => (view.enteredAt < first ? view.enteredAt : first), new Date());
    await storeUsageBatch(connection, userId, parsed.batch, startedAt);
    return NO_CONTENT;
  } catch (error: unknown) {
    context.error("postUsageEvents failed:", error instanceof Error ? error.message : String(error));
    return errorResponse("Could not record usage", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("postUsageEvents", { authLevel: "anonymous", handler: postUsageEvents, methods: ["POST"] });
