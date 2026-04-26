import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { preflightResponse } from "../cors";

async function handleOptions(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  return preflightResponse(request);
}

// Catch-all OPTIONS handler — handles CORS preflight for every endpoint.
// Specific routes still take priority; this only matches OPTIONS.
app.http("corsOptions", {
  methods: ["OPTIONS"],
  route: "{*catchall}",
  authLevel: "anonymous",
  handler: handleOptions,
});
