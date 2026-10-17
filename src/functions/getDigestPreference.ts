import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { errorResponse, requireRole, unauthorizedResponse, verifiedIdentityFromRequest } from "../auth";
import { AppRole } from "../auth";
import { closeConnection, createServiceRequestConnection } from "../db";
import { readDigestOptOut } from "../digest/preference";
import { checkRateLimit } from "../rateLimit";

// ── GET /api/getDigestPreference ──────────────────────────────────────────────
// Whether the signed-in person has switched the morning digest email off. Any
// signed-in user; the answer is about the caller only, found by their verified
// token. { digestOptOut: false } for someone who never chose.

export async function getDigestPreference(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  // Any signed-in staff member may read or set their own digest preference;
  // the role gate exists so the route guard (and check-routes) can see it.
  const denied = await requireRole(request, Object.values(AppRole));
  if (denied) return denied;
  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  const limited = checkRateLimit(`digestPreference:oid:${identity.oid}`, { limit: 20, windowMs: 60_000 });
  if (!limited.allowed) {
    return {
      headers: { "Retry-After": String(Math.ceil(limited.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
      status: 429,
    };
  }

  let connection;
  try {
    connection = await createServiceRequestConnection();
    const optOut = await readDigestOptOut(connection, identity.oid);
    if (optOut === null) return { jsonBody: { error: "No active user for this sign-in" }, status: 404 };
    return { jsonBody: { digestOptOut: optOut }, status: 200 };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("getDigestPreference failed:", message);
    return errorResponse("Failed to read the digest preference", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getDigestPreference", { authLevel: "anonymous", handler: getDigestPreference, methods: ["GET"] });
