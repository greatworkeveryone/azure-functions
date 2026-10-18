import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { AppRole, errorResponse, extractToken, requireRole, rolesForRequest, unauthorizedResponse } from "../auth";
import { closeConnection, createRequestConnection } from "../db";
import { isMyobController } from "../myob-controls-admin";
import { isMappingKind } from "../myob/mappingsAdmin/mappingKinds";
import { exportMappingsCsv, loadMappingsView } from "../myob/mappingsAdmin/mappingsView";

// GET /api/getMyobMappings?kind=suppliers|accounts|buildings[&format=csv] —
// the CFO's MYOB mappings (plan M2) as a table, or as the CSV she exports and
// re-imports ({ filename, text }). Readable by cfo (and director and admin
// through requireRole's hierarchy, as the other MYOB admin views); `canChange`
// is true only for the CFO.

export async function getMyobMappings(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const forbidden = await requireRole(request, [AppRole.CFO]);
  if (forbidden) return forbidden;
  const kind = request.query.get("kind");
  if (!isMappingKind(kind)) return { jsonBody: { error: "kind must be suppliers, accounts or buildings" }, status: 400 };

  let connection;
  try {
    const roles = await rolesForRequest(request);
    connection = await createRequestConnection(token);
    if (request.query.get("format") === "csv") return { jsonBody: await exportMappingsCsv(connection, kind), status: 200 };
    return { jsonBody: { ...(await loadMappingsView(connection, kind)), canChange: isMyobController(roles) }, status: 200 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("getMyobMappings failed:", message);
    return errorResponse("Failed to load the MYOB mappings", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getMyobMappings", { authLevel: "anonymous", handler: getMyobMappings, methods: ["GET"] });
