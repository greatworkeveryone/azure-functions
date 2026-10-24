// POST /api/archiveCoverDelegate   Body { coverDelegateId, rowVersion, reason? }
//
// Ends a nomination (it is archived, never deleted). The person, their reporting-line
// manager or a manager of their team can end it. A stale rowVersion is a 409.
//
// 200 { ended: true }
// 400 bad body; 403 not theirs to end; 404 already ended or unknown; 409 changed
//
// Gate: OWN_COVER_ROLES (the viewLeave capability), then nominate.ts.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import { coverErrorResponse, requireCoverCaller } from "../absenceCover/access";
import { coverError } from "../absenceCover/errors";
import { archiveNomination } from "../absenceCover/nominate";
import { OWN_COVER_ROLES } from "../absenceCover/roles";
import { closeConnection, createRequestConnection } from "../db";
import { checkRateLimit } from "../rateLimit";
import { inTransaction } from "../rentReview/store";

export async function archiveCoverDelegate(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, OWN_COVER_ROLES);
  if (denied) return denied;

  let connection;
  try {
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw coverError.badRequest("The request body must be a JSON object.");
    const { coverDelegateId, rowVersion, reason } = body as Record<string, unknown>;
    if (typeof coverDelegateId !== "number" || !Number.isSafeInteger(coverDelegateId) || coverDelegateId < 1) throw coverError.badRequest("coverDelegateId is required.");
    if (typeof rowVersion !== "string" || rowVersion === "") throw coverError.badRequest("rowVersion is required: send back the one you were given.");
    if (reason !== undefined && reason !== null && typeof reason !== "string") throw coverError.badRequest("The reason must be text.");
    connection = await createRequestConnection(token);
    const caller = await requireCoverCaller(request, connection);
    const limited = checkRateLimit(`archiveCoverDelegate:${caller.userId}`, { limit: 20, windowMs: 60_000 });
    if (!limited.allowed) {
      return { headers: { "Retry-After": String(Math.ceil(limited.retryAfterMs / 1000)) }, jsonBody: { error: "Too many requests. Try again shortly." }, status: 429 };
    }
    const conn = connection;
    await inTransaction(conn, () => archiveNomination(conn, caller, coverDelegateId, rowVersion, (reason as string | null | undefined) ?? null));
    return { jsonBody: { ended: true }, status: 200 };
  } catch (error: unknown) {
    return coverErrorResponse(error, context, "archiveCoverDelegate");
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("archiveCoverDelegate", { methods: ["POST"], authLevel: "anonymous", handler: archiveCoverDelegate });
