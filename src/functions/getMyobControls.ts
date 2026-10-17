import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { closeConnection, createRequestConnection } from "../db";
import { AppRole, errorResponse, extractToken, requireRole, rolesForRequest, unauthorizedResponse } from "../auth";
import { isMyobController } from "../myob-controls-admin";
import { loadControlsView } from "../myob-controls-view";

// GET /api/getMyobControls — the CFO's MYOB switches for every known company
// file, today's use against each allowance, and the master switch. Readable by
// cfo (and, through requireRole's hierarchy, director and admin); `canChange`
// is true only for the CFO, who alone may change them (setMyobControl, pauseMyob).

export async function getMyobControls(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const forbidden = await requireRole(request, [AppRole.CFO]);
  if (forbidden) return forbidden;

  let connection;
  try {
    const roles = await rolesForRequest(request);
    connection = await createRequestConnection(token);
    const view = await loadControlsView(connection);
    return { jsonBody: { ...view, canChange: isMyobController(roles) }, status: 200 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("getMyobControls failed:", message);
    return errorResponse("Failed to load MYOB controls", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getMyobControls", { authLevel: "anonymous", handler: getMyobControls, methods: ["GET"] });
