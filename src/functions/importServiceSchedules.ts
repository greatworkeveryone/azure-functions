// POST /api/importServiceSchedules[?dryRun=true]   multipart: file (xlsx, <= 10 MB)
//
// Bulk-adds service schedules from the template (getServiceScheduleTemplate).
// Every row is checked first; if any row is wrong nothing is written and the
// answer lists each bad row with its reason (400). Otherwise all rows are added
// in one transaction, each ledgered. dryRun=true checks and previews without
// writing. Managers only. Response: { created, duplicatesSkipped, preview? } or { errors }.
//
// Idempotent: a row whose natural key (building, asset, location, scope, name,
// contractor, interval, anchor date) already matches a live schedule, or an
// earlier row of the file, is skipped and counted in duplicatesSkipped, so a
// retry after a client timeout adds nothing. Imports run one at a time.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { errorResponse, unauthorizedResponse } from "../auth";
import { authorizeWrite, badRequest, errorMessage, inTransaction, txFail, txOk } from "../assetRegisterSupport";
import { todayInDarwin } from "../darwinDate";
import { closeConnection, createRequestConnection } from "../db";
import { MANAGE_SERVICE_SCHEDULES_ROLES } from "../facilitiesRoles";
import { resolveLedgerActor } from "../ledger/actor";
import { planNextDue } from "../serviceScheduleRefs";
import { loadImportLookups, MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, readImportRows, rowToInput } from "../serviceScheduleImport";
import { insertRun } from "../serviceScheduleRuns";
import { insertSchedule, loadScheduleNaturalKeys, lockServiceScheduleImport, scheduleNaturalKey } from "../serviceScheduleWrite";
import { XlsxRejectedError } from "../xlsx-safe";
import type { ScheduleInput } from "../serviceSchedules";

interface FileLike {
  arrayBuffer(): Promise<ArrayBuffer>;
  size: number;
}

export async function importServiceSchedules(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, MANAGE_SERVICE_SCHEDULES_ROLES);
  if (!auth.ok) return auth.response;
  const dryRun = request.query.get("dryRun") === "true";

  let file: FileLike | null;
  try {
    file = (await request.formData()).get("file") as unknown as FileLike | null;
  } catch {
    return badRequest("Send the spreadsheet as multipart form data in a 'file' field");
  }
  if (!file || typeof file.arrayBuffer !== "function") return badRequest("'file' field required");
  if (file.size > MAX_IMPORT_BYTES) return { jsonBody: { error: "The file is over 10 MB" }, status: 413 };

  let connection: Connection | undefined;
  try {
    let rows;
    try {
      rows = await readImportRows(Buffer.from(await file.arrayBuffer()));
    } catch (error) {
      if (error instanceof XlsxRejectedError) return badRequest(error.message);
      throw error;
    }
    if (rows.length === 0) return badRequest("The spreadsheet has no schedules in it");
    if (rows.length > MAX_IMPORT_ROWS) return badRequest(`Import at most ${MAX_IMPORT_ROWS} schedules at a time`);

    connection = await createRequestConnection(auth.token);
    const conn = connection;
    const today = todayInDarwin();
    const lookups = await loadImportLookups(conn);
    const errors: Array<{ error: string; row: number }> = [];
    const valid: Array<{ buildingName: string; input: ScheduleInput; lastServiced: string | null; nextDue: string; row: number }> = [];
    for (const row of rows) {
      const result = rowToInput(row, lookups, today);
      if (!result.ok) {
        errors.push({ error: result.error, row: row.row });
        continue;
      }
      const nextDue = planNextDue(result.value, null, today);
      if (!nextDue.ok) errors.push({ error: String((nextDue.response.jsonBody as { error: string }).error), row: row.row });
      else valid.push({ buildingName: result.buildingName, input: result.value, lastServiced: result.lastServiced, nextDue: nextDue.value, row: row.row });
    }
    if (errors.length > 0) return { jsonBody: { error: `${errors.length} row(s) need fixing; nothing was imported`, errors }, status: 400 };
    // Splits `valid` into rows to add and rows whose key is already taken.
    const split = (known: Set<string>): { fresh: typeof valid; skipped: typeof valid } => {
      const seen = new Set(known);
      const fresh: typeof valid = [];
      const skipped: typeof valid = [];
      for (const item of valid) {
        const key = scheduleNaturalKey(item.input);
        if (seen.has(key)) skipped.push(item);
        else {
          seen.add(key);
          fresh.push(item);
        }
      }
      return { fresh, skipped };
    };
    if (dryRun) {
      const { fresh, skipped } = split(await loadScheduleNaturalKeys(conn));
      const preview = fresh.map((item) => ({ building: item.buildingName, name: item.input.name, nextDue: item.nextDue, row: item.row }));
      return { jsonBody: { created: 0, duplicatesSkipped: skipped.length, preview }, status: 200 };
    }

    const outcome = await inTransaction(conn, async () => {
      const actor = await resolveLedgerActor(request, conn);
      if (!actor) return txFail(unauthorizedResponse());
      await lockServiceScheduleImport(conn);
      const { fresh, skipped } = split(await loadScheduleNaturalKeys(conn));
      for (const item of fresh) {
        const schedule = await insertSchedule(conn, item.input, item.nextDue, auth.caller.name, actor, today);
        // The last service from the spreadsheet becomes history (UX review E3).
        if (item.lastServiced) {
          await insertRun(conn, {
            actorName: auth.caller.name,
            completedOn: item.lastServiced,
            defectsPeriodId: null,
            due: item.lastServiced,
            jobId: null,
            note: "Last service, from the import",
            outcome: "recorded",
            scheduleId: schedule.serviceScheduleId,
          });
        }
      }
      return txOk({ created: fresh.length, duplicatesSkipped: skipped.length });
    });
    if (!outcome.ok) return outcome.response;
    return { jsonBody: outcome.value, status: 200 };
  } catch (error) {
    context.error("importServiceSchedules failed:", errorMessage(error));
    return errorResponse("Failed to import service schedules", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("importServiceSchedules", { authLevel: "anonymous", handler: importServiceSchedules, methods: ["POST"] });
