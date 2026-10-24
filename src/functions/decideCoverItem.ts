// POST /api/decideCoverItem   Body { itemType, itemId, decision: "move" | "keep", coverUserId? }
//
// A manager's one-tap decision on an item waiting on someone who is away: move it to
// the proposed cover (or to one they choose, who must be allowed to take it), or keep it
// where it is. The picture is read again here; an item that has since moved or is no
// longer at risk is a 409. Live only: with ABSENCE_COVER_ENABLED unset, or in dry run,
// nothing moves (409 cover_switched_off). Admin is refused (decision 4). Nothing is
// approved: a move changes who has the item, and the move and its ledger row are one
// transaction.
//
// 200 { decision, coverActionId, toUserId }
// 400 bad body; 403 not your team / admin; 409 changed or switched off; 422 no cover,
// not movable from here, or the chosen person may not take it
//
// Gate: MANAGE_COVER_ROLES (frontend capability manageAbsenceCover), then access.ts.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import { coverErrorResponse, requireCoverCaller } from "../absenceCover/access";
import { coverMode } from "../absenceCover/config";
import { decideCoverItem as decide, parseDecision } from "../absenceCover/decide";
import { coverError } from "../absenceCover/errors";
import { MANAGE_COVER_ROLES } from "../absenceCover/roles";
import { closeConnection, createRequestConnection } from "../db";
import { checkRateLimit } from "../rateLimit";

export async function decideCoverItem(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, MANAGE_COVER_ROLES);
  if (denied) return denied;

  let connection;
  try {
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw coverError.badRequest("The request body must be a JSON object.");
    const input = parseDecision(body as Record<string, unknown>);
    connection = await createRequestConnection(token);
    const caller = await requireCoverCaller(request, connection);
    const limited = checkRateLimit(`decideCoverItem:${caller.userId}`, { limit: 60, windowMs: 60_000 });
    if (!limited.allowed) {
      return { headers: { "Retry-After": String(Math.ceil(limited.retryAfterMs / 1000)) }, jsonBody: { error: "Too many requests. Try again shortly." }, status: 429 };
    }
    return { jsonBody: await decide(connection, caller, input, coverMode()), status: 200 };
  } catch (error: unknown) {
    return coverErrorResponse(error, context, "decideCoverItem");
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("decideCoverItem", { methods: ["POST"], authLevel: "anonymous", handler: decideCoverItem });
