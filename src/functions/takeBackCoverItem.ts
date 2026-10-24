// POST /api/takeBackCoverItem   Body { coverActionId }
//
// The returning person takes back an item that was moved to their cover: it goes back
// to them through the same write that moved it, and the take-back is logged (`taken_back`,
// naming the move it undoes) in the same transaction. Only the person it was moved from can
// do this, and only for a hand-over to a cover that is still with that cover: an item
// pushed up its ladder, a notice about a quote, or one the cover has finished is refused
// with the reason. Taking back stops the engine moving that item again for the same absence.
//
// 200 { coverActionId }   (the take-back's own ledger row)
// 400 bad body; 404 not one of yours; 409 already taken back or no longer with the cover;
// 422 cannot be taken back
//
// Gate: OWN_COVER_ROLES (the viewLeave capability), then handback.ts.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import { coverErrorResponse, requireCoverCaller } from "../absenceCover/access";
import { coverError } from "../absenceCover/errors";
import { takeBackItem } from "../absenceCover/handback";
import { OWN_COVER_ROLES } from "../absenceCover/roles";
import { closeConnection, createRequestConnection } from "../db";
import { checkRateLimit } from "../rateLimit";

export async function takeBackCoverItem(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, OWN_COVER_ROLES);
  if (denied) return denied;

  let connection;
  try {
    const body: unknown = await request.json().catch(() => null);
    const id = body !== null && typeof body === "object" ? (body as Record<string, unknown>).coverActionId : undefined;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) throw coverError.badRequest("coverActionId is required.");
    connection = await createRequestConnection(token);
    const caller = await requireCoverCaller(request, connection);
    const limited = checkRateLimit(`takeBackCoverItem:${caller.userId}`, { limit: 60, windowMs: 60_000 });
    if (!limited.allowed) {
      return { headers: { "Retry-After": String(Math.ceil(limited.retryAfterMs / 1000)) }, jsonBody: { error: "Too many requests. Try again shortly." }, status: 429 };
    }
    return { jsonBody: await takeBackItem(connection, caller, id), status: 200 };
  } catch (error: unknown) {
    return coverErrorResponse(error, context, "takeBackCoverItem");
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("takeBackCoverItem", { methods: ["POST"], authLevel: "anonymous", handler: takeBackCoverItem });
