// GET /api/getDefectsPeriods?buildingId&includeArchived
//
// Defects liability periods (LAUNCH-READINESS §5, sprint F1), soonest end
// first. Without buildingId: every building. Archived periods only with
// includeArchived=true. Read by every operational role: whoever creates jobs
// needs the warnings. Response: { periods }.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { errorResponse } from "../auth";
import { authorize, badRequest, errorMessage } from "../assetRegisterSupport";
import { todayInDarwin } from "../darwinDate";
import { closeConnection, createRequestConnection } from "../db";
import { listPeriods, periodRowToApi } from "../defectsPeriods";
import { VIEW_FACILITIES_ROLES } from "../facilitiesRoles";

export async function getDefectsPeriods(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorize(request, VIEW_FACILITIES_ROLES);
  if (!auth.ok) return auth.response;

  const rawBuilding = request.query.get("buildingId");
  const buildingId = rawBuilding === null || rawBuilding === "" ? null : Number(rawBuilding);
  if (buildingId !== null && (!Number.isInteger(buildingId) || buildingId === 0)) {
    return badRequest("buildingId must be a whole number");
  }
  const includeArchived = request.query.get("includeArchived") === "true";

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const rows = await listPeriods(connection, { buildingId, includeArchived });
    const today = todayInDarwin();
    return { jsonBody: { periods: rows.map((row) => periodRowToApi(row, today)) }, status: 200 };
  } catch (error) {
    context.error("getDefectsPeriods failed:", errorMessage(error));
    return errorResponse("Failed to load defects periods", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getDefectsPeriods", { authLevel: "anonymous", handler: getDefectsPeriods, methods: ["GET"] });
