// POST /api/recordServiceOutcome
//   Body: { serviceScheduleId, outcome: "serviced" | "skipped", servicedOn?, reason? }
//
// Closes out a schedule's current due date without a Floorplan job (UX review
// E4): "serviced" (it was done, e.g. under the contractor's own visit; on
// servicedOn, default today) or "skipped" (this one won't happen; reason
// required). Either way the run is recorded, the schedule moves to the next
// date of its series, and the decision is ledgered (a skip as an exception).
// Refused while a job for that due date is still open: finish or archive it.
// Managers only. Response: { schedule }.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES, type Connection } from "tedious";
import { errorResponse, unauthorizedResponse } from "../auth";
import {
  authorizeWrite,
  badRequest,
  conflict,
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
import { nextDueAfter } from "../facilitiesRules";
import { record } from "../ledger";
import { resolveLedgerActor } from "../ledger/actor";
import { advanceNextDue, insertRun } from "../serviceScheduleRuns";
import { fetchSchedule, isRealDate, scheduleRowToApi, scheduleSnapshot, seriesOf, type ScheduleApi } from "../serviceSchedules";

type Input = { outcome: "serviced" | "skipped"; reason: string | null; scheduleId: number; servicedOn: string };

function parse(body: Record<string, unknown>, today: string): { error: string } | Input {
  if (!Number.isInteger(body.serviceScheduleId) || (body.serviceScheduleId as number) <= 0) return { error: "serviceScheduleId is required" };
  if (body.outcome !== "serviced" && body.outcome !== "skipped") return { error: 'outcome must be "serviced" or "skipped"' };
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 500) : null;
  if (body.outcome === "skipped" && !reason) return { error: "Give a reason for skipping this due date" };
  const servicedOn = body.servicedOn === undefined || body.servicedOn === null ? today : body.servicedOn;
  if (!isRealDate(servicedOn)) return { error: "servicedOn must be a date (YYYY-MM-DD)" };
  if (servicedOn > today) return { error: "The service date can't be after today" };
  return { outcome: body.outcome, reason, scheduleId: body.serviceScheduleId as number, servicedOn };
}

export async function recordServiceOutcome(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, MANAGE_SERVICE_SCHEDULES_ROLES);
  if (!auth.ok) return auth.response;
  const body = await readJsonBody(request);
  if (!body) return badRequest("Request body must be a JSON object");
  const today = todayInDarwin();
  const input = parse(body, today);
  if ("error" in input) return badRequest(input.error);

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const conn = connection;
    const outcome = await inTransaction(conn, async (): Promise<TxResult<ScheduleApi>> => {
      const row = await fetchSchedule(conn, input.scheduleId, true);
      if (!row) return txFail(notFound("Service schedule not found"));
      const before = scheduleRowToApi(row, today);
      if (before.archived) return txFail(conflict("This schedule is archived."));
      const due = before.nextDue;
      const runs = await executeQuery(
        conn,
        `SELECT r.ServiceScheduleRunId, r.JobId, j.Status AS JobStatus, j.IsArchived AS JobArchived
           FROM dbo.ServiceScheduleRuns r
           LEFT JOIN dbo.Jobs j ON j.JobID = r.JobId
          WHERE r.ServiceScheduleId = @Id AND r.DueDate = @DueDate`,
        [
          { name: "Id", type: TYPES.Int, value: input.scheduleId },
          { name: "DueDate", type: TYPES.Date, value: due },
        ],
      );
      const run = runs[0];
      if (run?.JobId != null && !run.JobArchived && run.JobStatus !== "Done") {
        return txFail(conflict(`Job #${Number(run.JobId)} is still open for this due date. Finish or archive it first.`));
      }
      const actor = await resolveLedgerActor(request, conn);
      if (!actor) return txFail(unauthorizedResponse());
      const completedOn = input.outcome === "serviced" ? input.servicedOn : null;
      if (run) {
        await executeQuery(
          conn,
          `UPDATE dbo.ServiceScheduleRuns SET Note = @Note, CompletedAt = COALESCE(@CompletedAt, CompletedAt) WHERE ServiceScheduleRunId = @RunId`,
          [
            { name: "RunId", type: TYPES.Int, value: Number(run.ServiceScheduleRunId) },
            { name: "Note", type: TYPES.NVarChar, value: input.reason },
            { name: "CompletedAt", type: TYPES.DateTime2, value: completedOn ? new Date(`${completedOn}T00:00:00Z`) : null },
          ],
        );
      } else {
        await insertRun(conn, {
          actorName: auth.caller.name,
          completedOn,
          defectsPeriodId: null,
          due,
          jobId: null,
          note: input.reason,
          outcome: input.outcome === "serviced" ? "recorded" : "skipped",
          scheduleId: input.scheduleId,
        });
      }
      await advanceNextDue(conn, input.scheduleId, due, nextDueAfter(seriesOf(before), due), null, auth.caller.name);
      const saved = scheduleRowToApi((await fetchSchedule(conn, input.scheduleId)) ?? row, today);
      await record(conn, {
        action: input.outcome === "serviced" ? "service_schedule.mark_serviced" : "service_schedule.skip_due",
        actor,
        after: scheduleSnapshot(saved),
        before: scheduleSnapshot(before),
        buildingId: saved.buildingId,
        computed: { dueDate: due, servicedOn: completedOn },
        reason: input.reason,
        subject: { id: input.scheduleId, type: "service_schedule" },
      });
      return txOk(saved);
    });
    if (!outcome.ok) return outcome.response;
    return { jsonBody: { schedule: outcome.value }, status: 200 };
  } catch (error) {
    context.error("recordServiceOutcome failed:", errorMessage(error));
    return errorResponse("Failed to record the service", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("recordServiceOutcome", { authLevel: "anonymous", handler: recordServiceOutcome, methods: ["POST"] });
