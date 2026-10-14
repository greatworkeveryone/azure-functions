import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { AppRole, errorResponse, extractToken, requireRole, rolesForRequest, unauthorizedResponse } from "../auth";
import { closeConnection, createRequestConnection } from "../db";
import { loadCompanyFilesView } from "../myob-company-files-view";
import { isMyobController } from "../myob-controls-admin";

// GET /api/getMyobCompanyFiles — every MYOB company file Floorplan knows, with
// its mode and who last changed it. Readable by cfo (and director and admin
// through requireRole's hierarchy); `canChange` is true only for the CFO.

export async function getMyobCompanyFiles(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const forbidden = await requireRole(request, [AppRole.CFO]);
  if (forbidden) return forbidden;

  let connection;
  try {
    const roles = await rolesForRequest(request);
    connection = await createRequestConnection(token);
    const view = await loadCompanyFilesView(connection);
    return { jsonBody: { ...view, canChange: isMyobController(roles) }, status: 200 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("getMyobCompanyFiles failed:", message);
    return errorResponse("Failed to load MYOB company files", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getMyobCompanyFiles", { authLevel: "anonymous", handler: getMyobCompanyFiles, methods: ["GET"] });
