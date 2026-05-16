import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractToken, requireRole, unauthorizedResponse, errorResponse } from "../auth";
import { getMyobAuthStatus } from "../myob-auth";

// Returns whether MYOB is linked and when the access token expires. Used by
// the admin page to render "Authorize" vs "Re-authorize" + expiry countdown.

async function myobAuthStatus(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const forbidden = await requireRole(request, ["Admin"]);
  if (forbidden) return forbidden;

  try {
    const status = await getMyobAuthStatus(token);
    return { status: 200, jsonBody: status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse("Failed to read MYOB auth status", message);
  }
}

app.http("myobAuthStatus", {
  methods: ["GET"],
  authLevel: "anonymous",
  handler: myobAuthStatus,
});
