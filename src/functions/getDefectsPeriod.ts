// GET /api/getDefectsPeriod?id
//
// One defects period, with the open jobs it covers today (spec §5 behaviour 4:
// "a new period lists open jobs it already covers"). Response:
// { period, coveredOpenJobs }.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { errorResponse } from "../auth";
import { authorize, badRequest, errorMessage, notFound } from "../assetRegisterSupport";
import { todayInDarwin } from "../darwinDate";
import { closeConnection, createRequestConnection } from "../db";
import { coveredOpenJobs, fetchPeriod, periodRowToApi } from "../defectsPeriods";
import { VIEW_FACILITIES_ROLES } from "../facilitiesRoles";

export async function getDefectsPeriod(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorize(request, VIEW_FACILITIES_ROLES);
  if (!auth.ok) return auth.response;

  const id = Number(request.query.get("id"));
  if (!Number.isInteger(id) || id <= 0) return badRequest("id must be a positive whole number");

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const row = await fetchPeriod(connection, id);
    if (!row) return notFound("Defects period not found");
    const today = todayInDarwin();
    const period = periodRowToApi(row, today);
    const covered = period.active ? await coveredOpenJobs(connection, period, today) : [];
    return { jsonBody: { coveredOpenJobs: covered, period }, status: 200 };
  } catch (error) {
    context.error("getDefectsPeriod failed:", errorMessage(error));
    return errorResponse("Failed to load the defects period", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getDefectsPeriod", { authLevel: "anonymous", handler: getDefectsPeriod, methods: ["GET"] });
