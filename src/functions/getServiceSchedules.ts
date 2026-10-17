// GET /api/getServiceSchedules?buildingId&assetId&category&dueBefore&includeArchived
//
// Service schedules (WP50, sprint F2), soonest due first, each with overdue,
// urgent and the date the scheduler creates its next job. dueBefore
// (YYYY-MM-DD) limits to schedules due on or before it. Read by every
// operational role. Response: { schedules }.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { errorResponse } from "../auth";
import { authorize, badRequest, errorMessage } from "../assetRegisterSupport";
import { todayInDarwin } from "../darwinDate";
import { closeConnection, createRequestConnection } from "../db";
import { VIEW_FACILITIES_ROLES } from "../facilitiesRoles";
import { MAINTENANCE_SERVICES } from "../facilitiesRules";
import { isRealDate, listSchedules, scheduleRowToApi } from "../serviceSchedules";

function idParam(request: HttpRequest, key: string): number | null | undefined {
  const raw = request.query.get(key);
  if (raw === null || raw === "") return null;
  const value = Number(raw);
  return Number.isInteger(value) && value !== 0 ? value : undefined;
}

export async function getServiceSchedules(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorize(request, VIEW_FACILITIES_ROLES);
  if (!auth.ok) return auth.response;

  const buildingId = idParam(request, "buildingId");
  const assetId = idParam(request, "assetId");
  if (buildingId === undefined || assetId === undefined) return badRequest("buildingId and assetId must be whole numbers");
  const category = request.query.get("category") || null;
  if (category !== null && !(MAINTENANCE_SERVICES as readonly string[]).includes(category)) return badRequest("Unknown category");
  const dueBefore = request.query.get("dueBefore") || null;
  if (dueBefore !== null && !isRealDate(dueBefore)) return badRequest("dueBefore must be a date (YYYY-MM-DD)");

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const rows = await listSchedules(connection, {
      assetId,
      buildingId,
      category,
      dueBefore,
      includeArchived: request.query.get("includeArchived") === "true",
    });
    const today = todayInDarwin();
    return { jsonBody: { schedules: rows.map((row) => scheduleRowToApi(row, today)) }, status: 200 };
  } catch (error) {
    context.error("getServiceSchedules failed:", errorMessage(error));
    return errorResponse("Failed to load service schedules", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getServiceSchedules", { authLevel: "anonymous", handler: getServiceSchedules, methods: ["GET"] });
