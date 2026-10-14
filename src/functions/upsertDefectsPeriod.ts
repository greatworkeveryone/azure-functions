// POST /api/upsertDefectsPeriod   Body: DefectsPeriodInput (+ defectsPeriodId and rowVersion to edit)
//
// Adds or edits a defects liability period (LAUNCH-READINESS §5, sprint F1).
// Managers only (facilities_manager, director, admin). An edit carries the
// rowVersion it read; if someone changed the period since, the answer is 409
// naming who, never a silent overwrite. A period cannot move to another
// building (archive it and add a new one). Every save is ledgered.
//
// Response: { period, created, coveredOpenJobs } - the open jobs the period
// covers today, so whoever enters it sees what is already booked (behaviour 4).

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
import { closeConnection, createRequestConnection, executeQuery, type SqlParam } from "../db";
import { resolvePeriodReferences } from "../defectsPeriodRefs";
import {
  coveredOpenJobs,
  displayDate,
  fetchPeriod,
  parseDefectsPeriodInput,
  periodRowToApi,
  periodSnapshot,
  serviceText,
  type DefectsPeriodApi,
  type DefectsPeriodInput,
} from "../defectsPeriods";
import { MANAGE_DEFECTS_PERIODS_ROLES } from "../facilitiesRoles";
import { record, type LedgerActor } from "../ledger";
import { resolveLedgerActor } from "../ledger/actor";

type Saved = { created: boolean; period: DefectsPeriodApi };

function valueParams(input: DefectsPeriodInput, caller: string): SqlParam[] {
  return [
    { name: "Scope", type: TYPES.NVarChar, value: input.scope },
    { name: "LevelName", type: TYPES.NVarChar, value: input.levelName },
    { name: "LocationId", type: TYPES.Int, value: input.locationId },
    { name: "TenantId", type: TYPES.Int, value: input.tenantId },
    { name: "Services", type: TYPES.NVarChar, value: serviceText(input.services) },
    { name: "Works", type: TYPES.NVarChar, value: input.works },
    { name: "ContractorId", type: TYPES.Int, value: input.contractorId },
    { name: "ContractorContact", type: TYPES.NVarChar, value: input.contractorContact },
    { name: "PracticalCompletion", type: TYPES.Date, value: input.practicalCompletion },
    { name: "EndsOn", type: TYPES.Date, value: input.endsOn },
    { name: "Enforcement", type: TYPES.NVarChar, value: input.enforcement },
    { name: "Notes", type: TYPES.NVarChar, value: input.notes },
    { name: "UpdatedBy", type: TYPES.NVarChar, value: caller },
  ];
}

async function create(connection: Connection, input: DefectsPeriodInput, caller: string, actor: LedgerActor, today: string): Promise<TxResult<Saved>> {
  const inserted = await executeQuery(
    connection,
    `INSERT INTO dbo.DefectsPeriods
       (BuildingId, Scope, LevelName, LocationId, TenantId, Services, Works, ContractorId,
        ContractorContact, PracticalCompletion, EndsOn, Enforcement, Notes, CreatedBy, UpdatedBy)
     OUTPUT INSERTED.DefectsPeriodId
     VALUES (@BuildingId, @Scope, @LevelName, @LocationId, @TenantId, @Services, @Works, @ContractorId,
        @ContractorContact, @PracticalCompletion, @EndsOn, @Enforcement, @Notes, @CreatedBy, @UpdatedBy)`,
    [
      { name: "BuildingId", type: TYPES.Int, value: input.buildingId },
      { name: "CreatedBy", type: TYPES.NVarChar, value: caller },
      ...valueParams(input, caller),
    ],
  );
  const id = Number(inserted[0]?.DefectsPeriodId);
  const row = await fetchPeriod(connection, id);
  if (!row) throw new Error(`Defects period ${id} vanished after insert`);
  const period = periodRowToApi(row, today);
  await record(connection, {
    action: "defects_period.create",
    actor,
    after: periodSnapshot(period),
    buildingId: period.buildingId,
    subject: { id, type: "defects_period" },
    tenantId: period.tenantId,
  });
  return txOk({ created: true, period });
}

async function update(connection: Connection, input: DefectsPeriodInput, caller: string, actor: LedgerActor, today: string): Promise<TxResult<Saved>> {
  const id = input.defectsPeriodId as number;
  const current = await fetchPeriod(connection, id, true);
  if (!current) return txFail(notFound("Defects period not found"));
  const before = periodRowToApi(current, today);
  if (before.archivedAt) return txFail(conflict("This defects period is archived. Restore it before editing."));
  if (before.buildingId !== input.buildingId) {
    return txFail(badRequest("A defects period can't move to another building. Archive it and add a new one."));
  }
  const stale = conflict(
    `${before.updatedBy ?? "Someone"} changed this defects period${before.updatedAt ? ` on ${displayDate(before.updatedAt.slice(0, 10))}` : ""}. Reload to see their change, then edit again.`,
  );
  if (before.rowVersion !== input.rowVersion) return txFail(stale);

  const updated = await executeQuery(
    connection,
    `UPDATE dbo.DefectsPeriods
        SET Scope = @Scope, LevelName = @LevelName, LocationId = @LocationId, TenantId = @TenantId,
            Services = @Services, Works = @Works, ContractorId = @ContractorId,
            ContractorContact = @ContractorContact, PracticalCompletion = @PracticalCompletion,
            EndsOn = @EndsOn, Enforcement = @Enforcement, Notes = @Notes,
            UpdatedAt = SYSUTCDATETIME(), UpdatedBy = @UpdatedBy
      OUTPUT INSERTED.DefectsPeriodId
      WHERE DefectsPeriodId = @Id AND RowVersion = @RowVersion`,
    [
      { name: "Id", type: TYPES.Int, value: id },
      { name: "RowVersion", type: TYPES.Binary, value: Buffer.from(input.rowVersion as string, "base64") },
      ...valueParams(input, caller),
    ],
  );
  if (updated.length === 0) return txFail(stale);
  const row = await fetchPeriod(connection, id);
  const period = periodRowToApi(row ?? current, today);
  await record(connection, {
    action: "defects_period.update",
    actor,
    after: periodSnapshot(period),
    before: periodSnapshot(before),
    buildingId: period.buildingId,
    subject: { id, type: "defects_period" },
    tenantId: period.tenantId,
  });
  return txOk({ created: false, period });
}

export async function upsertDefectsPeriod(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, MANAGE_DEFECTS_PERIODS_ROLES);
  if (!auth.ok) return auth.response;

  const body = await readJsonBody(request);
  if (!body) return badRequest("Request body must be a JSON object");
  const parsed = parseDefectsPeriodInput(body);
  if (!parsed.ok) return badRequest(parsed.error);

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const conn = connection;
    const today = todayInDarwin();
    const outcome = await inTransaction(conn, async (): Promise<TxResult<Saved>> => {
      const actor = await resolveLedgerActor(request, conn);
      if (!actor) return txFail(unauthorizedResponse());
      const refs = await resolvePeriodReferences(conn, parsed.value);
      if (!refs.ok) return refs;
      return refs.value.defectsPeriodId === null
        ? create(conn, refs.value, auth.caller.name, actor, today)
        : update(conn, refs.value, auth.caller.name, actor, today);
    });
    if (!outcome.ok) return outcome.response;
    const { period } = outcome.value;
    const covered = period.active ? await coveredOpenJobs(conn, period, today) : [];
    return { jsonBody: { ...outcome.value, coveredOpenJobs: covered }, status: 200 };
  } catch (error) {
    context.error("upsertDefectsPeriod failed:", errorMessage(error));
    return errorResponse("Failed to save the defects period", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("upsertDefectsPeriod", { authLevel: "anonymous", handler: upsertDefectsPeriod, methods: ["POST"] });
