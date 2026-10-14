// POST /api/upsertServiceSchedule   Body: ScheduleInput (+ serviceScheduleId and rowVersion to edit)
//
// Adds or edits a recurring service (WP50, sprint F2). Managers only. A new
// schedule is due on the first anchor-series date from today unless nextDue
// names another date on the series. An edit carries the rowVersion it read
// (409 naming who changed it otherwise); changing the anchor or interval
// recomputes the next due date without skipping one that is overdue. A
// schedule can't move buildings. Ledgered. Response: { schedule, created }.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
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
import { closeConnection, createRequestConnection } from "../db";
import { MANAGE_SERVICE_SCHEDULES_ROLES } from "../facilitiesRoles";
import { resolveLedgerActor } from "../ledger/actor";
import { planNextDue, resolveScheduleReferences } from "../serviceScheduleRefs";
import { insertSchedule, updateSchedule } from "../serviceScheduleWrite";
import { fetchSchedule, parseScheduleInput, scheduleRowToApi, type ScheduleApi } from "../serviceSchedules";

type Saved = { created: boolean; schedule: ScheduleApi };

export async function upsertServiceSchedule(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, MANAGE_SERVICE_SCHEDULES_ROLES);
  if (!auth.ok) return auth.response;

  const body = await readJsonBody(request);
  if (!body) return badRequest("Request body must be a JSON object");
  const parsed = parseScheduleInput(body);
  if (!parsed.ok) return badRequest(parsed.error);

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const conn = connection;
    const today = todayInDarwin();
    const outcome = await inTransaction(conn, async (): Promise<TxResult<Saved>> => {
      const actor = await resolveLedgerActor(request, conn);
      if (!actor) return txFail(unauthorizedResponse());
      const refs = await resolveScheduleReferences(conn, parsed.value);
      if (!refs.ok) return refs;
      const input = refs.value;

      if (input.serviceScheduleId === null) {
        const nextDue = planNextDue(input, null, today);
        if (!nextDue.ok) return nextDue;
        return txOk({ created: true, schedule: await insertSchedule(conn, input, nextDue.value, auth.caller.name, actor, today) });
      }

      const row = await fetchSchedule(conn, input.serviceScheduleId, true);
      if (!row) return txFail(notFound("Service schedule not found"));
      const before = scheduleRowToApi(row, today);
      if (before.archived) return txFail(conflict("This schedule is archived. Restore it before editing."));
      if (before.buildingId !== input.buildingId) return txFail(badRequest("A schedule can't move to another building. Archive it and add a new one."));
      const stale = conflict(`${before.updatedBy ?? "Someone"} changed this schedule since you opened it. Reload to see their change, then edit again.`);
      if (before.rowVersion !== input.rowVersion) return txFail(stale);
      const nextDue = planNextDue(input, before, today);
      if (!nextDue.ok) return nextDue;
      const saved = await updateSchedule(conn, before, input, nextDue.value, auth.caller.name, actor, today);
      return saved ? txOk({ created: false, schedule: saved }) : txFail(stale);
    });
    if (!outcome.ok) return outcome.response;
    return { jsonBody: outcome.value, status: 200 };
  } catch (error) {
    context.error("upsertServiceSchedule failed:", errorMessage(error));
    return errorResponse("Failed to save the service schedule", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("upsertServiceSchedule", { authLevel: "anonymous", handler: upsertServiceSchedule, methods: ["POST"] });
