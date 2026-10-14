// Service schedule runs (WP50; sprint F2): what the scheduler did for each due
// date of each schedule, and what happens when the job's work is completed.
//
// A run row is written in the same transaction as the job it created, and the
// unique index on (ServiceScheduleId, DueDate) means a second attempt for the
// same due date fails and rolls its job back: one job per due date, however
// many times the scheduler runs.

import { TYPES, type Connection } from "tedious";
import { executeQuery, type SqlRow } from "./db";
import { Sentry } from "./sentry";
import { serviceJobTitle, nextDueAfter, type IntervalUnit } from "./facilitiesRules";
import { scheduleTarget, type ScheduleApi } from "./serviceSchedules";

export const RUN_OUTCOMES = ["job_created", "skipped_defects", "recorded", "skipped"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];
export const SCHEDULED_JOB_EVENT = "scheduled";
export const SCHEDULED_CREATION_METHOD = "schedule";

export interface RunApi {
  completedAt: string | null;
  createdAt: string | null;
  defectsPeriodId: number | null;
  dueDate: string;
  jobId: number | null;
  jobStatus: string | null;
  jobTitle: string | null;
  /** Why a manager skipped it, or what they noted when marking it serviced. */
  note: string | null;
  outcome: RunOutcome;
  serviceScheduleId: number;
}

const iso = (value: unknown): string | null => (value ? new Date(value as Date).toISOString() : null);

export function runRowToApi(row: SqlRow): RunApi {
  return {
    completedAt: iso(row.CompletedAt),
    createdAt: iso(row.CreatedAt),
    defectsPeriodId: row.DefectsPeriodId == null ? null : Number(row.DefectsPeriodId),
    dueDate: (iso(row.DueDate) ?? "").slice(0, 10),
    jobId: row.JobId == null ? null : Number(row.JobId),
    jobStatus: row.JobStatus == null ? null : String(row.JobStatus),
    jobTitle: row.JobTitle == null ? null : String(row.JobTitle),
    note: row.Note == null ? null : String(row.Note),
    outcome: (RUN_OUTCOMES as readonly string[]).includes(String(row.Outcome)) ? (row.Outcome as RunOutcome) : "job_created",
    serviceScheduleId: Number(row.ServiceScheduleId),
  };
}

export async function listRuns(connection: Connection, scheduleId: number): Promise<RunApi[]> {
  const rows = await executeQuery(
    connection,
    `SELECT r.ServiceScheduleId, r.DueDate, r.JobId, r.Outcome, r.DefectsPeriodId, r.CompletedAt, r.CreatedAt, r.Note,
            j.Title AS JobTitle, j.Status AS JobStatus
       FROM dbo.ServiceScheduleRuns r
       LEFT JOIN dbo.Jobs j ON j.JobID = r.JobId
      WHERE r.ServiceScheduleId = @ScheduleId
      ORDER BY r.DueDate DESC`,
    [{ name: "ScheduleId", type: TYPES.Int, value: scheduleId }],
  );
  return rows.map(runRowToApi);
}

function unitLabel(count: number, unit: IntervalUnit): string {
  const singular = unit === "weeks" ? "week" : "month";
  return count === 1 ? `every ${singular}` : `every ${count} ${unit}`;
}

/** Creates the maintenance job for one due date, links the asset, records the run. Caller owns the transaction. */
export async function createScheduledJob(connection: Connection, schedule: ScheduleApi, due: string, actorName: string): Promise<number> {
  const target = scheduleTarget(schedule);
  const description = [
    `Recurring service, ${unitLabel(schedule.intervalCount, schedule.intervalUnit)}, due ${due.split("-").reverse().join("/")}.`,
    schedule.scope && schedule.assetName ? `Scope: ${schedule.scope}.` : null,
    schedule.contractorName ? `Contractor: ${schedule.contractorName}.` : null,
    schedule.isContract ? "Standing contract: no quote needed." : null,
    schedule.notes,
  ]
    .filter(Boolean)
    .join(" ");
  const inserted = await executeQuery(
    connection,
    `INSERT INTO Jobs (BuildingID, Title, Description, Status, AwaitingRole, Kind, Category, IsContract,
                       ExpectedProgressUpdate, CreationMethod, CreatedBy, LevelName, StatusSince)
     OUTPUT INSERTED.JobID
     VALUES (@BuildingID, @Title, @Description, 'New', 'facilities', 'maintenance', @Category, @IsContract,
             @ExpectedProgressUpdate, @CreationMethod, @CreatedBy, @LevelName, SYSUTCDATETIME())`,
    [
      { name: "BuildingID", type: TYPES.Int, value: schedule.buildingId },
      { name: "Title", type: TYPES.NVarChar, value: serviceJobTitle(schedule.name, target, due).slice(0, 255) },
      { name: "Description", type: TYPES.NVarChar, value: description },
      { name: "Category", type: TYPES.NVarChar, value: schedule.category },
      { name: "IsContract", type: TYPES.Bit, value: schedule.isContract },
      { name: "ExpectedProgressUpdate", type: TYPES.DateTime2, value: new Date(`${due}T00:00:00Z`) },
      { name: "CreationMethod", type: TYPES.NVarChar, value: SCHEDULED_CREATION_METHOD },
      { name: "CreatedBy", type: TYPES.NVarChar, value: actorName },
      { name: "LevelName", type: TYPES.NVarChar, value: schedule.levelName },
    ],
  );
  const jobId = Number(inserted[0]?.JobID);
  if (!Number.isInteger(jobId) || jobId <= 0) throw new Error(`No job id came back for schedule ${schedule.serviceScheduleId}`);

  await executeQuery(
    connection,
    `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType) VALUES (@JobID, @CreatedBy, @Text, @EventType)`,
    [
      { name: "JobID", type: TYPES.Int, value: jobId },
      { name: "CreatedBy", type: TYPES.NVarChar, value: actorName },
      { name: "Text", type: TYPES.NVarChar, value: `Created from the service schedule "${schedule.name}" for the service due ${due.split("-").reverse().join("/")}` },
      { name: "EventType", type: TYPES.NVarChar, value: SCHEDULED_JOB_EVENT },
    ],
  );
  if (schedule.assetId !== null) {
    await executeQuery(
      connection,
      `INSERT INTO dbo.JobAssets (JobId, AssetId, LinkedBy)
         SELECT @JobId, @AssetId, @LinkedBy
          WHERE NOT EXISTS (SELECT 1 FROM dbo.JobAssets
                             WHERE JobId = @JobId AND AssetId = @AssetId AND UnlinkedAt IS NULL)`,
      [
        { name: "JobId", type: TYPES.Int, value: jobId },
        { name: "AssetId", type: TYPES.Int, value: schedule.assetId },
        { name: "LinkedBy", type: TYPES.NVarChar, value: actorName },
      ],
    );
  }
  await insertRun(connection, { actorName, defectsPeriodId: null, due, jobId, outcome: "job_created", scheduleId: schedule.serviceScheduleId });
  return jobId;
}

export async function insertRun(
  connection: Connection,
  run: {
    actorName: string;
    completedOn?: string | null;
    defectsPeriodId: number | null;
    due: string;
    jobId: number | null;
    note?: string | null;
    outcome: RunOutcome;
    scheduleId: number;
  },
): Promise<void> {
  await executeQuery(
    connection,
    `INSERT INTO dbo.ServiceScheduleRuns (ServiceScheduleId, DueDate, JobId, Outcome, DefectsPeriodId, CompletedAt, Note, CreatedBy)
     VALUES (@ScheduleId, @DueDate, @JobId, @Outcome, @DefectsPeriodId, @CompletedAt, @Note, @CreatedBy)`,
    [
      { name: "CompletedAt", type: TYPES.DateTime2, value: run.completedOn ? new Date(`${run.completedOn}T00:00:00Z`) : null },
      { name: "Note", type: TYPES.NVarChar, value: run.note ?? null },
      { name: "ScheduleId", type: TYPES.Int, value: run.scheduleId },
      { name: "DueDate", type: TYPES.Date, value: run.due },
      { name: "JobId", type: TYPES.Int, value: run.jobId },
      { name: "Outcome", type: TYPES.NVarChar, value: run.outcome },
      { name: "DefectsPeriodId", type: TYPES.Int, value: run.defectsPeriodId },
      { name: "CreatedBy", type: TYPES.NVarChar, value: run.actorName },
    ],
  );
}

/** Moves a schedule's NextDue from `due` to the next occurrence, only if it is
 *  still `due`. `updatedBy` names what moved it (the scheduler, a completing
 *  person, a manager), so a later stale-edit 409 names the real cause. */
export async function advanceNextDue(
  connection: Connection,
  scheduleId: number,
  due: string,
  next: string,
  completedJobId: number | null,
  updatedBy: string,
): Promise<boolean> {
  const rows = await executeQuery(
    connection,
    `UPDATE dbo.ServiceSchedules
        SET NextDue = @Next, LastCompletedJobId = COALESCE(@JobId, LastCompletedJobId),
            UpdatedAt = SYSUTCDATETIME(), UpdatedBy = @UpdatedBy
      OUTPUT INSERTED.ServiceScheduleId
      WHERE ServiceScheduleId = @Id AND NextDue = @Due`,
    [
      { name: "Id", type: TYPES.Int, value: scheduleId },
      { name: "Due", type: TYPES.Date, value: due },
      { name: "Next", type: TYPES.Date, value: next },
      { name: "JobId", type: TYPES.Int, value: completedJobId },
      { name: "UpdatedBy", type: TYPES.NVarChar, value: updatedBy.slice(0, 200) },
    ],
  );
  return rows.length > 0;
}

/** A transition that means the work is done: on to invoice approval, or Done. */
export function isWorkCompletion(status: string | null, awaitingRole: string | null): boolean {
  return status === "Done" || (status === "Awaiting Approval" && awaitingRole === "accounts");
}

/**
 * Called inside addJobEvent's transaction when a job's work is completed. If the
 * job came from a schedule: stamps the run complete and, when the schedule is
 * still waiting on that due date, moves NextDue to the next occurrence after it
 * (from the anchor series, never from today). Idempotent; a no-op for other jobs.
 */
// Migration 120 is applied by hand. If this code reaches a database without
// it, completing a job must still work: no table means no schedule to move,
// said loudly to Sentry. (A missing object fails only the statement, not the
// surrounding transaction.)
const MISSING_TABLE = /Invalid object name 'dbo\.(ServiceScheduleRuns|ServiceSchedules)'/i;

export async function markServiceJobCompleted(connection: Connection, jobId: number, completedBy: string): Promise<{ advancedTo: string | null }> {
  let runs: SqlRow[];
  try {
    runs = await executeQuery(
      connection,
      `SELECT r.ServiceScheduleRunId, r.ServiceScheduleId, r.DueDate, r.CompletedAt,
              s.NextDue, s.AnchorDate, s.IntervalCount, s.IntervalUnit
         FROM dbo.ServiceScheduleRuns r
         JOIN dbo.ServiceSchedules s ON s.ServiceScheduleId = r.ServiceScheduleId
        WHERE r.JobId = @JobId`,
      [{ name: "JobId", type: TYPES.Int, value: jobId }],
    );
  } catch (error) {
    if (!(error instanceof Error) || !MISSING_TABLE.test(error.message)) throw error;
    Sentry.captureMessage("dbo.ServiceScheduleRuns is missing: apply migration 120. Job completion did not check schedules.", "error");
    return { advancedTo: null };
  }
  const run = runs[0];
  if (!run) return { advancedTo: null };
  if (!run.CompletedAt) {
    await executeQuery(
      connection,
      `UPDATE dbo.ServiceScheduleRuns SET CompletedAt = SYSUTCDATETIME() WHERE ServiceScheduleRunId = @RunId AND CompletedAt IS NULL`,
      [{ name: "RunId", type: TYPES.Int, value: Number(run.ServiceScheduleRunId) }],
    );
  }
  const due = (iso(run.DueDate) ?? "").slice(0, 10);
  if ((iso(run.NextDue) ?? "").slice(0, 10) !== due) return { advancedTo: null };
  const next = nextDueAfter(
    {
      anchorDate: (iso(run.AnchorDate) ?? "").slice(0, 10),
      intervalCount: Number(run.IntervalCount),
      intervalUnit: run.IntervalUnit === "weeks" ? "weeks" : "months",
    },
    due,
  );
  const advanced = await advanceNextDue(connection, Number(run.ServiceScheduleId), due, next, jobId, `${completedBy} (job #${jobId} completed)`);
  return { advancedTo: advanced ? next : null };
}
