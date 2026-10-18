// jobPlannerSync — eager + idempotent reconcilers for the action-triggered
// Planner tasks bound to a single job:
//
//   • awaiting_accounts   — AwaitingRole = 'accounts'
//   • stalled_facilities  — IsStalled = 1 AND AwaitingRole IN (NULL,'facilities')
//   • oncharge_pending    — IsOnchargeable = 1 AND no outgoing invoice yet
//   • director_approval   — any JobInvoices(Status='approved') OR Quotes(Status='awaiting_director')
//
// Each *sync* function is idempotent: call it after an action commits (eager
// fire) or from the nightly plannerSyncTimer (safety net). The standalone
// wrappers open their own service connection + load group members and swallow
// errors so a caller's HTTP response never fails because Planner is down.
//
// Everything here is a no-op unless PLANNER_SYNC_ENABLED is "true" (plannerFlag.ts):
// Planner is being retired and APP_BASE_URL, which used to be what switched this
// on, now only builds links. With the flag on, behaviour is unchanged, including
// the skip when APP_BASE_URL or a group id is unset.

import { TYPES } from "tedious";
import type { Connection } from "tedious";
import { closeConnection, createServiceConnection, executeQuery, type SqlRow } from "./db";
import { SUBJECT_ELIGIBLE_ROLES } from "./approvalAuthority";
import { DIRECTOR_NEEDED_COLUMNS_J, withDirectorNeeded } from "./directorNeeded";
import { runsContractorFlow } from "./jobKinds";
import {
  getPlanConfig,
  graphCompletePlannerTask,
  graphCreatePlannerTask,
  graphGetGroupMembers,
  graphGetPlannerTask,
} from "./planner";
import { plannerSyncEnabled } from "./plannerFlag";
import { TestDataEgressError } from "./test-data";
import { Sentry } from "./sentry";
import {
  addDaysUTC,
  buildAwaitingAccountsTaskDescription,
  buildAwaitingFacilitiesApprovalTaskDescription,
  buildDirectorApprovalTaskDescription,
  buildOnchargeTaskDescription,
  buildStalledJobTaskDescription,
  buildTaskTitle,
  toIsoDateString,
  type PlannerAccountsJobRow,
  type PlannerOnchargeJobRow,
  type PlannerStalledJobRow,
  type TriggerType,
} from "./plannerHelpers";

type LogFn = (msg: string) => void;

/** Planner follows the contractor and money flow. An Admin / Accounts job has
 *  neither (plan D2), so no job sync creates, updates or completes a task for one. */
const followsPlanner = (job: SqlRow): boolean => runsContractorFlow(job.Kind);

/** Persist a failed Graph attempt onto an existing PlannerTasks row so the
 *  job-detail UI surfaces it via the `lastError` field. Failure to write
 *  itself is logged but otherwise swallowed — we don't want a tracking write
 *  to mask the original error. Re-throws nothing; caller decides. */
async function recordRowError(
  connection: Connection,
  rowId: number,
  message: string,
  log?: LogFn,
): Promise<void> {
  try {
    await executeQuery(
      connection,
      `UPDATE dbo.PlannerTasks
       SET LastSyncedAt = SYSUTCDATETIME(),
           LastError = @Error,
           AttemptCount = AttemptCount + 1
       WHERE Id = @Id`,
      [
        { name: "Id", type: TYPES.Int, value: rowId },
        { name: "Error", type: TYPES.NVarChar, value: message.slice(0, 1000) },
      ],
    );
  } catch (writeErr: unknown) {
    const writeMsg = writeErr instanceof Error ? writeErr.message : String(writeErr);
    log?.(`recordRowError: failed to persist error on row ${rowId}: ${writeMsg}`);
  }
}

// ── Shared reconcile primitive ───────────────────────────────────────────────
// Every trigger's create-or-resolve flow is identical once you've decided
// whether the task should exist and what its title/description/due/assignees
// look like. Centralising it here keeps the per-trigger functions to just
// "load state → build params → call reconcile."

export interface ReconcileParams {
  connection: Connection;
  entityType: "job" | "key";
  entityId: number;
  triggerType: TriggerType;
  shouldHaveTask: boolean;
  /** PlanType column value — 'accounts' or 'facilities'. Stored on the row
   *  for the dashboard / debugging; not used by the Graph call. */
  planType: "accounts" | "facilities";
  title: string;
  description: string;
  /** ISO yyyy-mm-dd. */
  dueDate: string;
  assigneeIds: string[];
  /** The job's or key's IsTest (D9): Planner refuses a test record's task. */
  isTest: boolean;
  log?: LogFn;
}

export async function reconcileTask(p: ReconcileParams): Promise<void> {
  if (!plannerSyncEnabled()) return;

  const {
    connection, entityType, entityId, triggerType, shouldHaveTask,
    planType, title, description, dueDate, assigneeIds, log,
  } = p;
  const egress = { isTest: p.isTest };

  const existing = await executeQuery(
    connection,
    `SELECT Id, PlannerTaskId, Status FROM dbo.PlannerTasks
     WHERE EntityType = @EntityType AND EntityId = @EntityId
       AND TriggerType = @TriggerType AND LeadTimeDays = 0`,
    [
      { name: "EntityType", type: TYPES.NVarChar, value: entityType },
      { name: "EntityId", type: TYPES.Int, value: entityId },
      { name: "TriggerType", type: TYPES.NVarChar, value: triggerType },
    ],
  );
  const row = existing[0];
  const rowId = row ? (row.Id as number) : null;
  const plannerTaskId = row ? (row.PlannerTaskId as string) : null;
  const rowStatus = row ? (row.Status as string) : null;

  if (shouldHaveTask) {
    const { planId, bucketId } = getPlanConfig(triggerType);
    if (!planId || !bucketId) {
      log?.(`reconcileTask: missing plan/bucket env for ${triggerType} — skipping ${entityType} ${entityId}`);
      return;
    }

    if (!row) {
      let taskId: string;
      try {
        taskId = await graphCreatePlannerTask({
          planId, bucketId, title, dueDate, assigneeIds, description, egress,
        });
      } catch (err: unknown) {
        if (!(err instanceof TestDataEgressError)) throw err;
        log?.(`reconcileTask: ${err.message} — no ${triggerType} task for ${entityType} ${entityId}`);
        return;
      }
      await executeQuery(
        connection,
        `INSERT INTO dbo.PlannerTasks
           (EntityType, EntityId, TriggerType, LeadTimeDays, PlannerTaskId, DueDate, PlanType,
            LastSyncedAt, LastError, AttemptCount)
         VALUES (@EntityType, @EntityId, @TriggerType, 0, @TaskId, @DueDate, @PlanType,
                 SYSUTCDATETIME(), NULL, 1)`,
        [
          { name: "EntityType", type: TYPES.NVarChar, value: entityType },
          { name: "EntityId", type: TYPES.Int, value: entityId },
          { name: "TriggerType", type: TYPES.NVarChar, value: triggerType },
          { name: "TaskId", type: TYPES.NVarChar, value: taskId },
          { name: "DueDate", type: TYPES.Date, value: new Date(dueDate) },
          { name: "PlanType", type: TYPES.NVarChar, value: planType },
        ],
      );
      log?.(`reconcileTask: created ${triggerType} for ${entityType} ${entityId}`);
      return;
    }

    if (rowStatus === "active") {
      let task: { etag: string } | null;
      try {
        task = await graphGetPlannerTask(plannerTaskId!);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        await recordRowError(connection, rowId!, message, log);
        throw err;
      }
      if (task) {
        await executeQuery(
          connection,
          `UPDATE dbo.PlannerTasks
           SET LastSyncedAt = SYSUTCDATETIME(), LastError = NULL,
               AttemptCount = AttemptCount + 1
           WHERE Id = @Id`,
          [{ name: "Id", type: TYPES.Int, value: rowId }],
        );
        return;
      }
      // Graph task was deleted — fall through to recreate.
    }

    let taskId: string;
    try {
      taskId = await graphCreatePlannerTask({
        planId, bucketId, title, dueDate, assigneeIds, description, egress,
      });
    } catch (err: unknown) {
      if (err instanceof TestDataEgressError) {
        log?.(`reconcileTask: ${err.message} — no ${triggerType} task for ${entityType} ${entityId}`);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      await recordRowError(connection, rowId!, message, log);
      throw err;
    }
    await executeQuery(
      connection,
      `UPDATE dbo.PlannerTasks
       SET PlannerTaskId = @TaskId, Status = 'active', DueDate = @DueDate,
           ResolvedAt = NULL, LastSyncedAt = SYSUTCDATETIME(), LastError = NULL,
           AttemptCount = AttemptCount + 1
       WHERE Id = @Id`,
      [
        { name: "TaskId", type: TYPES.NVarChar, value: taskId },
        { name: "DueDate", type: TYPES.Date, value: new Date(dueDate) },
        { name: "Id", type: TYPES.Int, value: rowId },
      ],
    );
    log?.(`reconcileTask: recreated ${triggerType} for ${entityType} ${entityId}`);
    return;
  }

  // Condition no longer holds — resolve any active task.
  if (row && rowStatus === "active") {
    try {
      const task = await graphGetPlannerTask(plannerTaskId!);
      if (task) await graphCompletePlannerTask(plannerTaskId!, task.etag);
    } catch (err: unknown) {
      // Continue to mark resolved locally — Graph may have lost the task.
      // Nightly sweep retries the next day if anything is off.
      log?.(
        `reconcileTask: graph complete failed for ${triggerType} ${entityType} ${entityId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    await executeQuery(
      connection,
      `UPDATE dbo.PlannerTasks
       SET Status = 'resolved', ResolvedAt = SYSUTCDATETIME(),
           LastSyncedAt = SYSUTCDATETIME(), LastError = NULL,
           AttemptCount = AttemptCount + 1
       WHERE Id = @Id`,
      [{ name: "Id", type: TYPES.Int, value: rowId }],
    );
    log?.(`reconcileTask: resolved ${triggerType} for ${entityType} ${entityId}`);
  }
}

// ── Per-trigger sync functions ───────────────────────────────────────────────

export interface AccountsSyncDeps {
  connection: Connection;
  accountsMembers: string[];
  appBaseUrl: string;
  log?: LogFn;
}

export interface FacilitiesSyncDeps {
  connection: Connection;
  facilitiesMembers: string[];
  appBaseUrl: string;
  log?: LogFn;
}

/** Oncharge-pending: charged-to-tenant work, awaiting outgoing invoice. */
export async function syncJobOnchargePending(
  jobId: number,
  deps: AccountsSyncDeps,
): Promise<void> {
  if (!plannerSyncEnabled()) return;
  const { connection, accountsMembers, appBaseUrl, log } = deps;
  const rows = await executeQuery(
    connection,
    `SELECT j.JobID, j.Title, j.IsTest, j.IsArchived, j.Status, j.Kind,
            j.IsOnchargeable, j.OnchargeAmount, j.OnchargeNotes,
            COALESCE(b.BuildingName, '') AS BuildingName,
            (SELECT TOP 1 1 FROM dbo.JobInvoices ji
             WHERE ji.JobID = j.JobID AND ji.Direction = 'outgoing') AS HasOutgoing
     FROM dbo.Jobs j
     LEFT JOIN dbo.Buildings b ON b.BuildingID = j.BuildingID
     WHERE j.JobID = @JobID`,
    [{ name: "JobID", type: TYPES.Int, value: jobId }],
  );
  if (rows.length === 0) return;
  const r = rows[0];
  if (!followsPlanner(r)) return;
  const job: PlannerOnchargeJobRow = {
    jobId: r.JobID as number,
    title: r.Title as string,
    buildingName: (r.BuildingName as string | null) ?? null,
    onchargeAmount: (r.OnchargeAmount as number | null) ?? null,
    onchargeNotes: (r.OnchargeNotes as string | null) ?? null,
  };
  const shouldHaveTask =
    Boolean(r.IsOnchargeable) &&
    !Boolean(r.IsArchived) &&
    (r.Status as string | null) !== "Done" &&
    !Boolean(r.HasOutgoing);

  await reconcileTask({
    connection,
    entityType: "job",
    entityId: jobId,
    isTest: Boolean(r.IsTest),
    triggerType: "oncharge_pending",
    shouldHaveTask,
    planType: "accounts",
    title: buildTaskTitle(job.title, "oncharge_pending", 0),
    description: buildOnchargeTaskDescription(job, appBaseUrl),
    dueDate: toIsoDateString(new Date()),
    assigneeIds: accountsMembers,
    log,
  });
}

/** Awaiting accounts: job handoff to accounts team. Assigns to the named
 *  assignee's Entra OID when the job has one (AppUsers join, same as
 *  syncJobStalled), falling back to the whole Accounts group otherwise. */
export async function syncJobAwaitingAccounts(
  jobId: number,
  deps: AccountsSyncDeps,
): Promise<void> {
  if (!plannerSyncEnabled()) return;
  const { connection, accountsMembers, appBaseUrl, log } = deps;
  const rows = await executeQuery(
    connection,
    `SELECT j.JobID, j.Title, j.IsTest, j.IsArchived, j.Status, j.Kind, j.AwaitingRole,
            COALESCE(b.BuildingName, '') AS BuildingName,
            au.EntraOid AS AssignedToEntraOid
     FROM dbo.Jobs j
     LEFT JOIN dbo.Buildings b ON b.BuildingID = j.BuildingID
     LEFT JOIN dbo.AppUsers au ON au.UserID = j.AssignedToUserID
     WHERE j.JobID = @JobID`,
    [{ name: "JobID", type: TYPES.Int, value: jobId }],
  );
  if (rows.length === 0) return;
  const r = rows[0];
  if (!followsPlanner(r)) return;
  const job: PlannerAccountsJobRow = {
    jobId: r.JobID as number,
    title: r.Title as string,
    buildingName: (r.BuildingName as string | null) ?? null,
  };
  const shouldHaveTask =
    !Boolean(r.IsArchived) &&
    (r.Status as string | null) !== "Done" &&
    (r.AwaitingRole as string | null) === "accounts";

  const assignedToEntraOid = (r.AssignedToEntraOid as string | null) ?? null;
  const assigneeIds = assignedToEntraOid ? [assignedToEntraOid] : accountsMembers;

  await reconcileTask({
    connection,
    entityType: "job",
    entityId: jobId,
    isTest: Boolean(r.IsTest),
    triggerType: "awaiting_accounts",
    shouldHaveTask,
    planType: "accounts",
    title: buildTaskTitle(job.title, "awaiting_accounts", 0),
    description: buildAwaitingAccountsTaskDescription(job, appBaseUrl),
    dueDate: toIsoDateString(new Date()),
    assigneeIds,
    log,
  });
}

/** Awaiting facilities approval: a quote is parked at
 *  (Awaiting Approval, facilities) needing sign-off. Mirrors awaiting-accounts
 *  but on the Facilities plan. Assigns to the named assignee OID when set
 *  (AppUsers join), falling back to the whole Facilities group. Due today. */
export async function syncJobAwaitingFacilitiesApproval(
  jobId: number,
  deps: FacilitiesSyncDeps,
): Promise<void> {
  if (!plannerSyncEnabled()) return;
  const { connection, facilitiesMembers, appBaseUrl, log } = deps;
  const rows = await executeQuery(
    connection,
    `SELECT j.JobID, j.Title, j.IsTest, j.IsArchived, j.Status, j.Kind, j.AwaitingRole,
            COALESCE(b.BuildingName, '') AS BuildingName,
            au.EntraOid AS AssignedToEntraOid, au.Role AS AssignedToRole
     FROM dbo.Jobs j
     LEFT JOIN dbo.Buildings b ON b.BuildingID = j.BuildingID
     LEFT JOIN dbo.AppUsers au ON au.UserID = j.AssignedToUserID
     WHERE j.JobID = @JobID`,
    [{ name: "JobID", type: TYPES.Int, value: jobId }],
  );
  if (rows.length === 0) return;
  const r = rows[0];
  if (!followsPlanner(r)) return;
  const job: PlannerAccountsJobRow = {
    jobId: r.JobID as number,
    title: r.Title as string,
    buildingName: (r.BuildingName as string | null) ?? null,
  };
  const shouldHaveTask =
    !Boolean(r.IsArchived) &&
    (r.Status as string | null) === "Awaiting Approval" &&
    (r.AwaitingRole as string | null) === "facilities";

  // J4: reviewing the quote is for someone who can approve it. The assignee
  // when they can; otherwise the approvers in the Facilities group.
  const assignedToEntraOid = (r.AssignedToEntraOid as string | null) ?? null;
  const assigneeIds =
    assignedToEntraOid && isQuoteApprover(r.AssignedToRole)
      ? [assignedToEntraOid]
      : shouldHaveTask
        ? await quoteApprovers(connection, facilitiesMembers)
        : facilitiesMembers;

  await reconcileTask({
    connection,
    entityType: "job",
    entityId: jobId,
    isTest: Boolean(r.IsTest),
    triggerType: "awaiting_facilities_approval",
    shouldHaveTask,
    planType: "facilities",
    title: buildTaskTitle(job.title, "awaiting_facilities_approval", 0),
    description: buildAwaitingFacilitiesApprovalTaskDescription(job, appBaseUrl),
    dueDate: toIsoDateString(new Date()),
    assigneeIds,
    log,
  });
}

/** Who may approve a quote on their own authority: J1's eligible roles less
 *  admin, which acts on test records only (decision 4). Plain facilities adds
 *  quotes but approves none (decision 1). */
const QUOTE_APPROVER_ROLES: readonly string[] = SUBJECT_ELIGIBLE_ROLES.quote.filter((role) => role !== "admin");

function isQuoteApprover(role: unknown): boolean {
  return typeof role === "string" && QUOTE_APPROVER_ROLES.includes(role.trim().toLowerCase());
}

/** The members of a Planner group who can approve a quote, or the whole group
 *  when none can (so the task still lands with someone who can chase it). */
async function quoteApprovers(connection: Connection, members: readonly string[]): Promise<string[]> {
  if (members.length === 0) return [...members];
  const people = await executeQuery(
    connection,
    "SELECT EntraOid, Role FROM dbo.AppUsers WHERE IsActive = 1 AND EntraOid IS NOT NULL",
  );
  const approvers = new Set(
    people.filter((person) => isQuoteApprover(person.Role)).map((person) => String(person.EntraOid).toLowerCase()),
  );
  const picked = members.filter((member) => approvers.has(member.toLowerCase()));
  return picked.length > 0 ? picked : [...members];
}

/** Stalled facilities: job marked stalled and not handed to accounts.
 *  Due date is 2 days after StalledAt (preserves the existing timer logic).
 *  Assignees: the named assignee if set, otherwise the whole Facilities group. */
export async function syncJobStalled(
  jobId: number,
  deps: FacilitiesSyncDeps,
): Promise<void> {
  if (!plannerSyncEnabled()) return;
  const { connection, facilitiesMembers, appBaseUrl, log } = deps;
  const rows = await executeQuery(
    connection,
    `SELECT j.JobID, j.Title, j.IsTest, j.IsArchived, j.Status, j.Kind, j.IsStalled, j.AwaitingRole,
            COALESCE(b.BuildingName, '') AS BuildingName,
            CONVERT(VARCHAR(23), j.StalledAt, 126) AS StalledAt,
            au.EntraOid AS AssignedToEntraOid
     FROM dbo.Jobs j
     LEFT JOIN dbo.Buildings b ON b.BuildingID = j.BuildingID
     LEFT JOIN dbo.AppUsers au ON au.UserID = j.AssignedToUserID
     WHERE j.JobID = @JobID`,
    [{ name: "JobID", type: TYPES.Int, value: jobId }],
  );
  if (rows.length === 0) return;
  const r = rows[0];
  if (!followsPlanner(r)) return;
  const awaitingRole = r.AwaitingRole as string | null;
  const job: PlannerStalledJobRow = {
    jobId: r.JobID as number,
    title: r.Title as string,
    buildingName: (r.BuildingName as string | null) ?? null,
    stalledAt: (r.StalledAt as string | null) ?? null,
    assignedToEntraOid: (r.AssignedToEntraOid as string | null) ?? null,
  };
  const shouldHaveTask =
    Boolean(r.IsStalled) &&
    !Boolean(r.IsArchived) &&
    (r.Status as string | null) !== "Done" &&
    (awaitingRole === null || awaitingRole === "facilities");

  const stalledDate = job.stalledAt ? new Date(job.stalledAt) : new Date();
  const dueDate = toIsoDateString(addDaysUTC(stalledDate, 2));
  const assigneeIds = job.assignedToEntraOid
    ? [job.assignedToEntraOid]
    : facilitiesMembers;

  await reconcileTask({
    connection,
    entityType: "job",
    entityId: jobId,
    isTest: Boolean(r.IsTest),
    triggerType: "stalled_facilities",
    shouldHaveTask,
    planType: "facilities",
    title: buildTaskTitle(job.title, "stalled_facilities", 0),
    description: buildStalledJobTaskDescription(job, appBaseUrl),
    dueDate,
    assigneeIds,
    log,
  });
}

/** Director approval: any approved invoice or awaiting-director quote on
 *  this job needs director sign-off. Resolves when both queues are empty.
 *  Assigns to the named assignee OID when set (AppUsers join), falling back to
 *  the whole Accounts group. */
export async function syncJobDirectorApproval(
  jobId: number,
  deps: AccountsSyncDeps,
): Promise<void> {
  if (!plannerSyncEnabled()) return;
  const { connection, accountsMembers, appBaseUrl, log } = deps;
  const rows = await executeQuery(
    connection,
    `SELECT j.JobID, j.Title, j.IsTest, j.IsArchived, j.Status, j.Kind,
            COALESCE(b.BuildingName, '') AS BuildingName,
            au.EntraOid AS AssignedToEntraOid,
            ${DIRECTOR_NEEDED_COLUMNS_J}
     FROM dbo.Jobs j
     LEFT JOIN dbo.Buildings b ON b.BuildingID = j.BuildingID
     LEFT JOIN dbo.AppUsers au ON au.UserID = j.AssignedToUserID
     WHERE j.JobID = @JobID`,
    [{ name: "JobID", type: TYPES.Int, value: jobId }],
  );
  if (rows.length === 0) return;
  // The final-state rule (directorNeeded.ts): a stage-1 invoice below the
  // director gate needs nobody.
  // Read before withDirectorNeeded drops it: the task opens on the quote when one waits.
  const step = Number(rows[0].QuotesAwaitingDirector ?? 0) > 0 ? "quotes" : "invoices";
  const r = (await withDirectorNeeded(connection, rows))[0];
  if (!followsPlanner(r)) return;
  const job: PlannerAccountsJobRow = {
    jobId: r.JobID as number,
    title: r.Title as string,
    buildingName: (r.BuildingName as string | null) ?? null,
  };
  const shouldHaveTask =
    !Boolean(r.IsArchived) &&
    (r.Status as string | null) !== "Done" &&
    ((r.DirectorNeededCount as number) ?? 0) > 0;

  const assignedToEntraOid = (r.AssignedToEntraOid as string | null) ?? null;
  const assigneeIds = assignedToEntraOid ? [assignedToEntraOid] : accountsMembers;

  await reconcileTask({
    connection,
    entityType: "job",
    entityId: jobId,
    isTest: Boolean(r.IsTest),
    triggerType: "director_approval",
    shouldHaveTask,
    planType: "accounts",
    title: buildTaskTitle(job.title, "director_approval", 0),
    description: buildDirectorApprovalTaskDescription(job, appBaseUrl, step),
    dueDate: toIsoDateString(new Date()),
    assigneeIds,
    log,
  });
}

// ── Combined eager-fire entrypoint ───────────────────────────────────────────

/** Runs every job-bound action trigger for a single job. Idempotent. Opens its
 *  own service connection + loads group members and swallows errors so the
 *  caller's response never fails because Planner/Graph is unavailable. The
 *  nightly plannerSyncTimer reconciles anything this misses. */
export async function syncJobActionTriggersStandalone(
  jobId: number,
  log?: LogFn,
): Promise<void> {
  if (!plannerSyncEnabled()) return;

  const {
    PLANNER_FACILITIES_GROUP_ID,
    PLANNER_ACCOUNTS_GROUP_ID,
    APP_BASE_URL,
  } = process.env;

  if (!PLANNER_FACILITIES_GROUP_ID || !PLANNER_ACCOUNTS_GROUP_ID || !APP_BASE_URL) {
    log?.(
      "syncJobActionTriggersStandalone: missing required env (facilities/accounts group or APP_BASE_URL) — skipping",
    );
    return;
  }

  let connection: Connection | undefined;
  try {
    const [facilitiesMembers, accountsMembers] = await Promise.all([
      graphGetGroupMembers(PLANNER_FACILITIES_GROUP_ID),
      graphGetGroupMembers(PLANNER_ACCOUNTS_GROUP_ID),
    ]);
    connection = await createServiceConnection();
    const accountsDeps: AccountsSyncDeps = {
      connection,
      accountsMembers,
      appBaseUrl: APP_BASE_URL,
      log,
    };
    const facilitiesDeps: FacilitiesSyncDeps = {
      connection,
      facilitiesMembers,
      appBaseUrl: APP_BASE_URL,
      log,
    };
    // Each step is independent and idempotent; isolate failures so one bad
    // Graph call doesn't suppress the others.
    const steps: ReadonlyArray<[string, () => Promise<void>]> = [
      ["awaiting_accounts", () => syncJobAwaitingAccounts(jobId, accountsDeps)],
      ["awaiting_facilities_approval", () => syncJobAwaitingFacilitiesApproval(jobId, facilitiesDeps)],
      ["stalled_facilities", () => syncJobStalled(jobId, facilitiesDeps)],
      ["oncharge_pending", () => syncJobOnchargePending(jobId, accountsDeps)],
      ["director_approval", () => syncJobDirectorApproval(jobId, accountsDeps)],
    ];
    for (const [label, fn] of steps) {
      try {
        await fn();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log?.(`syncJobActionTriggersStandalone: ${label} failed for job ${jobId}: ${message}`);
        Sentry.captureException(err, {
          tags: {
            source: "job_planner_sync_eager",
            trigger: label,
            jobId: String(jobId),
          },
        });
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log?.(`syncJobActionTriggersStandalone failed for job ${jobId}: ${message}`);
    Sentry.captureException(err, {
      tags: {
        source: "job_planner_sync_eager",
        scope: "setup",
        jobId: String(jobId),
      },
    });
  } finally {
    if (connection) closeConnection(connection);
  }
}

