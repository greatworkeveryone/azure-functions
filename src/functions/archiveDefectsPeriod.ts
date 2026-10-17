// POST /api/archiveDefectsPeriod   Body: { defectsPeriodId, archived?, reason? }
//
// Archives a defects period (it stops covering anything) or, with
// archived: false, restores it. Never deletes. Managers only. Both directions
// are idempotent and ledgered with the optional reason. Response: { period }.

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
import { fetchPeriod, parseArchiveInput, periodRowToApi, periodSnapshot, type DefectsPeriodApi } from "../defectsPeriods";
import { MANAGE_DEFECTS_PERIODS_ROLES } from "../facilitiesRoles";
import { record } from "../ledger";
import { resolveLedgerActor } from "../ledger/actor";

const ARCHIVE = `UPDATE dbo.DefectsPeriods
    SET ArchivedAt = SYSUTCDATETIME(), ArchivedBy = @Caller, UpdatedAt = SYSUTCDATETIME(), UpdatedBy = @Caller
  WHERE DefectsPeriodId = @Id AND ArchivedAt IS NULL`;
const RESTORE = `UPDATE dbo.DefectsPeriods
    SET ArchivedAt = NULL, ArchivedBy = NULL, UpdatedAt = SYSUTCDATETIME(), UpdatedBy = @Caller
  WHERE DefectsPeriodId = @Id AND ArchivedAt IS NOT NULL`;

export async function archiveDefectsPeriod(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, MANAGE_DEFECTS_PERIODS_ROLES);
  if (!auth.ok) return auth.response;

  const body = await readJsonBody(request);
  if (!body) return badRequest("Request body must be a JSON object");
  const parsed = parseArchiveInput(body);
  if (!parsed.ok) return badRequest(parsed.error);
  const { archived, defectsPeriodId, reason } = parsed.value;

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const conn = connection;
    const today = todayInDarwin();
    const outcome = await inTransaction(conn, async (): Promise<TxResult<DefectsPeriodApi>> => {
      const row = await fetchPeriod(conn, defectsPeriodId, true);
      if (!row) return txFail(notFound("Defects period not found"));
      const before = periodRowToApi(row, today);
      if ((before.archivedAt !== null) === archived) return txOk(before);
      const actor = await resolveLedgerActor(request, conn);
      if (!actor) return txFail(unauthorizedResponse());
      await executeQuery(conn, archived ? ARCHIVE : RESTORE, [
        { name: "Id", type: TYPES.Int, value: defectsPeriodId },
        { name: "Caller", type: TYPES.NVarChar, value: auth.caller.name },
      ]);
      const saved = periodRowToApi((await fetchPeriod(conn, defectsPeriodId)) ?? row, today);
      await record(conn, {
        action: archived ? "defects_period.archive" : "defects_period.restore",
        actor,
        after: periodSnapshot(saved),
        before: periodSnapshot(before),
        buildingId: saved.buildingId,
        reason,
        subject: { id: defectsPeriodId, type: "defects_period" },
        tenantId: saved.tenantId,
      });
      return txOk(saved);
    });
    if (!outcome.ok) return outcome.response;
    return { jsonBody: { period: outcome.value }, status: 200 };
  } catch (error) {
    context.error("archiveDefectsPeriod failed:", errorMessage(error));
    return errorResponse(archived ? "Failed to archive the defects period" : "Failed to restore the defects period", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("archiveDefectsPeriod", { authLevel: "anonymous", handler: archiveDefectsPeriod, methods: ["POST"] });
