// dbo.RentScheduleChangeLog (migration 061): an append-only trail of every add,
// update and delete of a tenancy's rate steps. Manual edits (functions/tenancy.ts)
// and the rent review workflow's writes (WP26: APPLY, WAIVE, REVERT) both write
// it, so a step's history reads the same whoever changed it, and REVERT finds a
// review's own writes here to take them back.

import { randomUUID } from "node:crypto";
import { type Connection, TYPES } from "tedious";
import { executeQuery } from "./db";
import type { ScheduledRateStep, StepDiff } from "./scheduledRateStepLogic";

export type ChangeKind = "added" | "deleted" | "updated";

export interface ChangeLogEntry {
  buildingId: number;
  changedById: string;
  changedByName: string;
  changeKind: ChangeKind;
  /** Field-level diff for an update; null for an add or a delete (the snapshot is the whole step). */
  diff: StepDiff | null;
  /** The step after the change (before it, for a delete). */
  stepSnapshot: ScheduledRateStep;
  stepId: string;
  tenantId: number;
}

/** Appends one entry and returns its ChangeId. */
export async function insertRentScheduleChangeLog(connection: Connection, entry: ChangeLogEntry): Promise<string> {
  const changeId = randomUUID();
  await executeQuery(
    connection,
    `INSERT INTO dbo.RentScheduleChangeLog
       (ChangeId, TenantId, BuildingId, StepId, ChangeKind,
        ChangedAt, ChangedById, ChangedByName, StepSnapshot, Diff)
     VALUES
       (@ChangeId, @TenantId, @BuildingId, @StepId, @ChangeKind,
        SYSUTCDATETIME(), @ChangedById, @ChangedByName, @StepSnapshot, @Diff)`,
    [
      { name: "ChangeId", type: TYPES.NVarChar, value: changeId },
      { name: "TenantId", type: TYPES.Int, value: entry.tenantId },
      { name: "BuildingId", type: TYPES.Int, value: entry.buildingId },
      { name: "StepId", type: TYPES.NVarChar, value: entry.stepId },
      { name: "ChangeKind", type: TYPES.NVarChar, value: entry.changeKind },
      { name: "ChangedById", type: TYPES.NVarChar, value: entry.changedById },
      { name: "ChangedByName", type: TYPES.NVarChar, value: entry.changedByName },
      { name: "StepSnapshot", type: TYPES.NVarChar, value: JSON.stringify(entry.stepSnapshot) },
      { name: "Diff", type: TYPES.NVarChar, value: entry.diff ? JSON.stringify(entry.diff) : null },
    ],
  );
  return changeId;
}

export interface LoggedChangeRow {
  changeId: string;
  changeKind: ChangeKind;
  diff: StepDiff | null;
  snapshot: ScheduledRateStep;
  stepId: string;
}

const MAX_IDS = 20;

/** The entries with these ids on this tenancy, in the order the ids are given;
 *  an id that isn't there (or belongs to another tenancy) is left out. */
export async function loadChangeLogEntries(
  connection: Connection,
  tenantId: number,
  changeIds: readonly string[],
): Promise<LoggedChangeRow[]> {
  const ids = changeIds.slice(0, MAX_IDS);
  if (ids.length === 0) return [];
  const placeholders = ids.map((_, index) => `@Change${index}`).join(", ");
  const rows = await executeQuery(
    connection,
    `SELECT ChangeId, StepId, ChangeKind, StepSnapshot, Diff
     FROM dbo.RentScheduleChangeLog
     WHERE TenantId = @TenantId AND ChangeId IN (${placeholders})`,
    [
      { name: "TenantId", type: TYPES.Int, value: tenantId },
      ...ids.map((id, index) => ({ name: `Change${index}`, type: TYPES.NVarChar, value: id })),
    ],
  );
  const byId = new Map(
    rows.map((row) => [
      String(row.ChangeId),
      {
        changeId: String(row.ChangeId),
        changeKind: row.ChangeKind as ChangeKind,
        diff: typeof row.Diff === "string" ? (JSON.parse(row.Diff) as StepDiff) : null,
        snapshot: JSON.parse(String(row.StepSnapshot)) as ScheduledRateStep,
        stepId: String(row.StepId),
      },
    ]),
  );
  return ids.map((id) => byId.get(id)).filter((row): row is LoggedChangeRow => row !== undefined);
}
