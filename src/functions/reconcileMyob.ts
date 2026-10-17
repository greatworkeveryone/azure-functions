import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { AppRole, errorResponse, extractToken, requireRole, rolesForRequest, unauthorizedResponse, verifiedIdentityFromRequest } from "../auth";
import { closeConnection, createRequestConnection } from "../db";
import { isMyobController } from "../myob-controls-admin";
import { reconcile, RECONCILE_LIMIT } from "../myob/activity/reconcile";
import { LIVE_READER } from "../myob/readbackClient";
import { checkRateLimit } from "../rateLimit";

// POST /api/reconcileMyob — { companyFileId? }: for each record Floorplan sent
// to MYOB (the latest verified proposal per record, at most 100), Floorplan's
// record against MYOB's, read now through the GET-only reader (SPR-M4).
// Matched, differs field by field, missing in MYOB, or not read and why. It
// writes nothing to Floorplan's records; each GET is logged in MyobApiLog as
// every MYOB call is. POST because each check calls MYOB. Readable by cfo (and
// director and admin, as the other MYOB views); 3 checks a minute per person.
// `canAccept` is true only for the CFO (acceptMyobBaseline).

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function reconcileMyob(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const forbidden = await requireRole(request, [AppRole.CFO]);
  if (forbidden) return forbidden;
  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const file = body.companyFileId ?? null;
  if (file !== null && (typeof file !== "string" || !GUID.test(file))) return { jsonBody: { error: "companyFileId must be a MYOB company file id" }, status: 400 };
  const limit = checkRateLimit(`reconcileMyob:${identity.oid}`, { limit: 3, windowMs: 60_000 });
  if (!limit.allowed) {
    return { headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) }, jsonBody: { error: "Checked against MYOB just now; try again in a minute" }, status: 429 };
  }

  let connection;
  try {
    const roles = await rolesForRequest(request);
    connection = await createRequestConnection(token);
    const now = new Date();
    const actor = { kind: "user" as const, name: identity.name, oid: identity.oid };
    const result = await reconcile(connection, actor, { companyFileId: file ? file.toLowerCase() : null, limit: RECONCILE_LIMIT }, { now, reader: LIVE_READER });
    return { jsonBody: { ...result, canAccept: isMyobController(roles), checkedAt: now.toISOString() }, status: 200 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("reconcileMyob failed:", message);
    return errorResponse("Failed to check against MYOB", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("reconcileMyob", { authLevel: "anonymous", handler: reconcileMyob, methods: ["POST"] });
