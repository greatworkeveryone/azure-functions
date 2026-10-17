// GET /api/getServiceSchedule?id
//
// One service schedule and its history: every due date the scheduler has
// handled, the job it created (and that job's status) or why it skipped.
// Response: { schedule, runs, schedulerMode }: the mode lets the drawer say
// whether the daily scheduler is making jobs yet.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { errorResponse } from "../auth";
import { authorize, badRequest, errorMessage, notFound } from "../assetRegisterSupport";
import { todayInDarwin } from "../darwinDate";
import { closeConnection, createRequestConnection } from "../db";
import { VIEW_FACILITIES_ROLES } from "../facilitiesRoles";
import { schedulerMode } from "../schedulerMode";
import { listRuns } from "../serviceScheduleRuns";
import { fetchSchedule, scheduleRowToApi } from "../serviceSchedules";

export async function getServiceSchedule(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorize(request, VIEW_FACILITIES_ROLES);
  if (!auth.ok) return auth.response;

  const id = Number(request.query.get("id"));
  if (!Number.isInteger(id) || id <= 0) return badRequest("id must be a positive whole number");

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const row = await fetchSchedule(connection, id);
    if (!row) return notFound("Service schedule not found");
    const runs = await listRuns(connection, id);
    return { jsonBody: { runs, schedule: scheduleRowToApi(row, todayInDarwin()), schedulerMode: schedulerMode() }, status: 200 };
  } catch (error) {
    context.error("getServiceSchedule failed:", errorMessage(error));
    return errorResponse("Failed to load the service schedule", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getServiceSchedule", { authLevel: "anonymous", handler: getServiceSchedule, methods: ["GET"] });
