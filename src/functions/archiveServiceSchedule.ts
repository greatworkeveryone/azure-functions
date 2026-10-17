// POST /api/archiveServiceSchedule   Body: { serviceScheduleId, archived?, reason? }
//
// Archives a service schedule (the scheduler stops creating jobs for it; its
// runs and jobs stay as history) or, with archived: false, restores it. Never
// deletes. Managers only. Idempotent both ways, ledgered with the optional
// reason. To pause without archiving, edit the schedule with active: false.
// Response: { schedule }.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES, type Connection } from "tedious";
import { errorResponse, unauthorizedResponse } from "../auth";
import {
  authorizeWrite,
  badRequest,
  errorMessage,
  inTransaction,
  notFound,
  readJsonBody,
  txFail,
  txOk,
  type TxResult,
} from "../assetRegisterSupport";
import { todayInDarwin } from "../darwinDate";
import { closeConnection, createRequestConnection, executeQuery } from "../db";
import { MANAGE_SERVICE_SCHEDULES_ROLES } from "../facilitiesRoles";
import { record } from "../ledger";
import { resolveLedgerActor } from "../ledger/actor";
import { fetchSchedule, scheduleRowToApi, scheduleSnapshot, type ScheduleApi } from "../serviceSchedules";

const ARCHIVE = `UPDATE dbo.ServiceSchedules
    SET ArchivedAt = SYSUTCDATETIME(), ArchivedBy = @Caller, UpdatedAt = SYSUTCDATETIME(), UpdatedBy = @Caller
  WHERE ServiceScheduleId = @Id AND ArchivedAt IS NULL`;
const RESTORE = `UPDATE dbo.ServiceSchedules
    SET ArchivedAt = NULL, ArchivedBy = NULL, UpdatedAt = SYSUTCDATETIME(), UpdatedBy = @Caller
  WHERE ServiceScheduleId = @Id AND ArchivedAt IS NOT NULL`;

export async function archiveServiceSchedule(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, MANAGE_SERVICE_SCHEDULES_ROLES);
  if (!auth.ok) return auth.response;

  const body = await readJsonBody(request);
  if (!body) return badRequest("Request body must be a JSON object");
  const id = body.serviceScheduleId;
  if (!Number.isInteger(id) || (id as number) <= 0) return badRequest("serviceScheduleId is required");
  if (body.archived !== undefined && typeof body.archived !== "boolean") return badRequest("archived must be true or false");
  if (body.reason !== undefined && body.reason !== null && (typeof body.reason !== "string" || body.reason.length > 500)) {
    return badRequest("reason must be text of 500 characters or fewer");
  }
  const archived = body.archived !== false;
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null;
  const scheduleId = id as number;

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const conn = connection;
    const today = todayInDarwin();
    const outcome = await inTransaction(conn, async (): Promise<TxResult<ScheduleApi>> => {
      const row = await fetchSchedule(conn, scheduleId, true);
      if (!row) return txFail(notFound("Service schedule not found"));
      const before = scheduleRowToApi(row, today);
      if (before.archived === archived) return txOk(before);
      const actor = await resolveLedgerActor(request, conn);
      if (!actor) return txFail(unauthorizedResponse());
      await executeQuery(conn, archived ? ARCHIVE : RESTORE, [
        { name: "Id", type: TYPES.Int, value: scheduleId },
        { name: "Caller", type: TYPES.NVarChar, value: auth.caller.name },
      ]);
      const saved = scheduleRowToApi((await fetchSchedule(conn, scheduleId)) ?? row, today);
      await record(conn, {
        action: archived ? "service_schedule.archive" : "service_schedule.restore",
        actor,
        after: scheduleSnapshot(saved),
        before: scheduleSnapshot(before),
        buildingId: saved.buildingId,
        reason,
        subject: { id: scheduleId, type: "service_schedule" },
      });
      return txOk(saved);
    });
    if (!outcome.ok) return outcome.response;
    return { jsonBody: { schedule: outcome.value }, status: 200 };
  } catch (error) {
    context.error("archiveServiceSchedule failed:", errorMessage(error));
    return errorResponse(archived ? "Failed to archive the schedule" : "Failed to restore the schedule", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("archiveServiceSchedule", { authLevel: "anonymous", handler: archiveServiceSchedule, methods: ["POST"] });
