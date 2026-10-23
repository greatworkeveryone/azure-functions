// Writes for service schedules (sprint F2), shared by upsertServiceSchedule and
// importServiceSchedules. The caller owns the transaction; every write is
// ledgered in it.

import { TYPES, type Connection } from "tedious";
import { executeQuery, type SqlParam } from "./db";
import { record, type LedgerActor } from "./ledger";
import { fetchSchedule, scheduleRowToApi, scheduleSnapshot, type ScheduleApi, type ScheduleInput } from "./serviceSchedules";

function valueParams(input: ScheduleInput, nextDue: string, caller: string): SqlParam[] {
  return [
    { name: "AssetId", type: TYPES.Int, value: input.assetId },
    { name: "LocationId", type: TYPES.Int, value: input.locationId },
    { name: "Scope", type: TYPES.NVarChar, value: input.scope },
    { name: "Category", type: TYPES.NVarChar, value: input.category },
    { name: "Name", type: TYPES.NVarChar, value: input.name },
    { name: "ContractorId", type: TYPES.Int, value: input.contractorId },
    { name: "IsContract", type: TYPES.Bit, value: input.isContract },
    { name: "IntervalCount", type: TYPES.Int, value: input.intervalCount },
    { name: "IntervalUnit", type: TYPES.NVarChar, value: input.intervalUnit },
    { name: "AnchorDate", type: TYPES.Date, value: input.anchorDate },
    { name: "LeadDays", type: TYPES.Int, value: input.leadDays },
    { name: "NextDue", type: TYPES.Date, value: nextDue },
    { name: "Active", type: TYPES.Bit, value: input.active },
    { name: "Notes", type: TYPES.NVarChar, value: input.notes },
    { name: "UpdatedBy", type: TYPES.NVarChar, value: caller },
  ];
}

export async function insertSchedule(
  connection: Connection,
  input: ScheduleInput,
  nextDue: string,
  caller: string,
  actor: LedgerActor,
  today: string,
): Promise<ScheduleApi> {
  const inserted = await executeQuery(
    connection,
    `INSERT INTO dbo.ServiceSchedules
       (BuildingId, AssetId, LocationId, Scope, Category, Name, ContractorId, IsContract, IntervalCount,
        IntervalUnit, AnchorDate, LeadDays, NextDue, Active, Notes, CreatedBy, UpdatedBy)
     OUTPUT INSERTED.ServiceScheduleId
     VALUES (@BuildingId, @AssetId, @LocationId, @Scope, @Category, @Name, @ContractorId, @IsContract, @IntervalCount,
        @IntervalUnit, @AnchorDate, @LeadDays, @NextDue, @Active, @Notes, @CreatedBy, @UpdatedBy)`,
    [
      { name: "BuildingId", type: TYPES.Int, value: input.buildingId },
      { name: "CreatedBy", type: TYPES.NVarChar, value: caller },
      ...valueParams(input, nextDue, caller),
    ],
  );
  const id = Number(inserted[0]?.ServiceScheduleId);
  const row = await fetchSchedule(connection, id);
  if (!row) throw new Error(`Service schedule ${id} vanished after insert`);
  const schedule = scheduleRowToApi(row, today);
  await record(connection, {
    action: "service_schedule.create",
    actor,
    after: scheduleSnapshot(schedule),
    buildingId: schedule.buildingId,
    subject: { id, type: "service_schedule" },
  });
  return schedule;
}

/** Null when the row version no longer matches (someone changed it). */
export async function updateSchedule(
  connection: Connection,
  before: ScheduleApi,
  input: ScheduleInput,
  nextDue: string,
  caller: string,
  actor: LedgerActor,
  today: string,
): Promise<ScheduleApi | null> {
  const id = before.serviceScheduleId;
  const updated = await executeQuery(
    connection,
    `UPDATE dbo.ServiceSchedules
        SET AssetId = @AssetId, LocationId = @LocationId, Scope = @Scope, Category = @Category, Name = @Name,
            ContractorId = @ContractorId, IsContract = @IsContract, IntervalCount = @IntervalCount,
            IntervalUnit = @IntervalUnit, AnchorDate = @AnchorDate, LeadDays = @LeadDays, NextDue = @NextDue,
            Active = @Active, Notes = @Notes, UpdatedAt = SYSUTCDATETIME(), UpdatedBy = @UpdatedBy
      OUTPUT INSERTED.ServiceScheduleId
      WHERE ServiceScheduleId = @Id AND RowVersion = @RowVersion`,
    [
      { name: "Id", type: TYPES.Int, value: id },
      { name: "RowVersion", type: TYPES.Binary, value: Buffer.from(input.rowVersion ?? "", "base64") },
      ...valueParams(input, nextDue, caller),
    ],
  );
  if (updated.length === 0) return null;
  const row = await fetchSchedule(connection, id);
  const schedule = row ? scheduleRowToApi(row, today) : before;
  await record(connection, {
    action: "service_schedule.update",
    actor,
    after: scheduleSnapshot(schedule),
    before: scheduleSnapshot(before),
    buildingId: schedule.buildingId,
    subject: { id, type: "service_schedule" },
  });
  return schedule;
}

// ── Import idempotency ───────────────────────────────────────────────────────

type KeyFields = Pick<ScheduleInput, "anchorDate" | "assetId" | "buildingId" | "contractorId" | "intervalCount" | "intervalUnit" | "locationId" | "name" | "scope">;

/** Natural key of a schedule: what makes a spreadsheet row "the same service" on a retry. */
export function scheduleNaturalKey(f: KeyFields): string {
  const text = (value: string | null): string | null => (value === null ? null : value.trim().toLowerCase());
  return JSON.stringify([f.buildingId, f.assetId, f.locationId, text(f.scope), text(f.name), f.contractorId, f.intervalCount, f.intervalUnit, f.anchorDate.slice(0, 10)]);
}

/** Serialises imports; a retry waits for the first run to commit, then sees its rows. Call inside the transaction. */
export async function lockServiceScheduleImport(connection: Connection): Promise<void> {
  const rows = await executeQuery(
    connection,
    `DECLARE @Result INT;
     EXEC @Result = sp_getapplock @Resource = N'import_service_schedules', @LockMode = N'Exclusive',
                                  @LockOwner = N'Transaction', @LockTimeout = 60000;
     SELECT @Result AS LockResult;`,
    [],
  );
  if (!(Number(rows[0]?.LockResult ?? -999) >= 0)) throw new Error("Could not take the service schedule import lock");
}

/** Natural keys of every live (unarchived) schedule. */
export async function loadScheduleNaturalKeys(connection: Connection): Promise<Set<string>> {
  const rows = await executeQuery(
    connection,
    `SELECT BuildingId, AssetId, LocationId, Scope, Name, ContractorId, IntervalCount, IntervalUnit, AnchorDate
       FROM dbo.ServiceSchedules WHERE ArchivedAt IS NULL`,
    [],
  );
  const keys = new Set<string>();
  for (const row of rows) {
    const anchor = row.AnchorDate instanceof Date ? row.AnchorDate.toISOString() : String(row.AnchorDate);
    keys.add(scheduleNaturalKey({
      anchorDate: anchor,
      assetId: row.AssetId === null ? null : Number(row.AssetId),
      buildingId: Number(row.BuildingId),
      contractorId: row.ContractorId === null ? null : Number(row.ContractorId),
      intervalCount: Number(row.IntervalCount),
      intervalUnit: row.IntervalUnit as ScheduleInput["intervalUnit"],
      locationId: row.LocationId === null ? null : Number(row.LocationId),
      name: String(row.Name),
      scope: row.Scope === null ? null : String(row.Scope),
    }));
  }
  return keys;
}
