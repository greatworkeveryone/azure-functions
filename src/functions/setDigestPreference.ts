import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { errorResponse, unauthorizedResponse, verifiedIdentityFromRequest } from "../auth";
import { closeConnection, createServiceRequestConnection } from "../db";
import { writeDigestOptOut } from "../digest/preference";
import { checkRateLimit } from "../rateLimit";

// ── POST /api/setDigestPreference ─────────────────────────────────────────────
// Body: { digestOptOut: boolean }. Switches the caller's own morning digest email
// off (true) or back on (false). Any signed-in user. The person is the verified
// token's, never a userId or email in the body.

export async function setDigestPreference(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = undefined;
  }
  const digestOptOut = (body as { digestOptOut?: unknown } | null | undefined)?.digestOptOut;
  if (typeof digestOptOut !== "boolean") {
    return { jsonBody: { error: "digestOptOut must be true or false" }, status: 400 };
  }

  let connection;
  try {
    connection = await createServiceRequestConnection();
    const stored = await writeDigestOptOut(connection, identity.oid, digestOptOut);
    if (stored === null) return { jsonBody: { error: "No active user for this sign-in" }, status: 404 };
    return { jsonBody: { digestOptOut: stored }, status: 200 };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("setDigestPreference failed:", message);
    return errorResponse("Failed to save the digest preference", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("setDigestPreference", { authLevel: "anonymous", handler: setDigestPreference, methods: ["POST"] });
