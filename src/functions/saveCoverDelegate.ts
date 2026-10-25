// POST /api/saveCoverDelegate
//   Body { delegateUserId, fromDate, toDate, userId?, leaveRequestId? }   (dates YYYY-MM-DD)
//
// Nominates who covers for a person for those dates, optionally tied to one of their
// leave requests. userId is left out for the caller's own; their reporting-line manager,
// a manager of their team, the CFO or a director can nominate for them. The cover must be
// an active person who works in Floorplan and is not admin. Saving the same nomination
// again changes nothing (created: false). Nothing moves by being nominated: the engine
// reads nominations when someone is away.
//
// 200 { created, nomination }
// 400 bad body; 403 not theirs to arrange; 404 unknown leave request; 422 cover or dates refused
//
// Gate: OWN_COVER_ROLES (the viewLeave capability), then nominate.ts.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import { coverErrorResponse, requireCoverCaller } from "../absenceCover/access";
import { coverError } from "../absenceCover/errors";
import { parseNomination, saveNomination } from "../absenceCover/nominate";
import { OWN_COVER_ROLES } from "../absenceCover/roles";
import { todayInDarwin } from "../darwinDate";
import { closeConnection, createRequestConnection } from "../db";
import { checkRateLimit } from "../rateLimit";

export async function saveCoverDelegate(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, OWN_COVER_ROLES);
  if (denied) return denied;

  let connection;
  try {
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw coverError.badRequest("The request body must be a JSON object.");
    const input = parseNomination(body as Record<string, unknown>);
    connection = await createRequestConnection(token);
    const caller = await requireCoverCaller(request, connection);
    const limited = checkRateLimit(`saveCoverDelegate:${caller.userId}`, { limit: 20, windowMs: 60_000 });
    if (!limited.allowed) {
      return { headers: { "Retry-After": String(Math.ceil(limited.retryAfterMs / 1000)) }, jsonBody: { error: "Too many requests. Try again shortly." }, status: 429 };
    }
    return { jsonBody: await saveNomination(connection, caller, input, todayInDarwin()), status: 200 };
  } catch (error: unknown) {
    return coverErrorResponse(error, context, "saveCoverDelegate");
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("saveCoverDelegate", { methods: ["POST"], authLevel: "anonymous", handler: saveCoverDelegate });
