import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { AppRole, extractToken, oidFromToken, requireRole, unauthorizedResponse, errorResponse } from "../auth";
import { buildAuthorizeUrl, generateAuthState } from "../myob-auth";
import { checkRateLimit } from "../rateLimit";

// Returns the MYOB authorize URL for the admin to open in a new tab. The
// browser sends the user to MYOB, MYOB redirects back to /myobAuthCallback
// with a code that's exchanged for tokens.

async function myobAuthStart(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const forbidden = await requireRole(request, [AppRole.ADMIN]);
  if (forbidden) return forbidden;

  const callerOid = oidFromToken(token) ?? "unknown";
  const rl = checkRateLimit(`myobAuthStart:${callerOid}`, { limit: 30, windowMs: 60_000 });
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  try {
    const state = generateAuthState();
    const authorizeUrl = buildAuthorizeUrl(state);
    return { status: 200, jsonBody: { authorizeUrl } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse("Failed to build MYOB authorize URL", message);
  }
}

app.http("myobAuthStart", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: myobAuthStart,
});
