import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import {
  AppRole,
  errorResponse,
  extractToken,
  oidFromToken,
  requireRole,
  unauthorizedResponse,
  verifiedIdentityFromRequest,
} from "../auth";
import { buildAuthorizeUrl } from "../myob-auth";
import { createAuthState } from "../myob-auth-state";
import { checkRateLimit } from "../rateLimit";

// Returns the MYOB authorize URL for the admin to open in a new tab. The state
// in it is single-use, valid for 10 minutes and records which admin started
// the link (from the verified token), so the callback can attribute it.

async function myobAuthStart(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const forbidden = await requireRole(request, [AppRole.ADMIN]);
  if (forbidden) return forbidden;

  const rl = checkRateLimit(`myobAuthStart:${oidFromToken(token) ?? "unknown"}`, { limit: 30, windowMs: 60_000 });
  if (!rl.allowed) {
    return {
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
      status: 429,
    };
  }

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  try {
    const state = await createAuthState({ name: identity.name, oid: identity.oid });
    return { jsonBody: { authorizeUrl: buildAuthorizeUrl(state) }, status: 200 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse("Failed to build MYOB authorize URL", message);
  }
}

export { myobAuthStart };

app.http("myobAuthStart", {
  authLevel: "anonymous",
  handler: myobAuthStart,
  methods: ["POST"],
});
