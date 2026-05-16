import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractToken, requireRole, unauthorizedResponse, errorResponse } from "../auth";
import { buildAuthorizeUrl, generateAuthState } from "../myob-auth";

// Returns the MYOB authorize URL for the admin to open in a new tab. The
// browser sends the user to MYOB, MYOB redirects back to /myobAuthCallback
// with a code that's exchanged for tokens.

async function myobAuthStart(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const forbidden = await requireRole(request, ["Admin"]);
  if (forbidden) return forbidden;

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
