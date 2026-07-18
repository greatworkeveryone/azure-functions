import { app, type InvocationContext, type Timer } from "@azure/functions";
import { TYPES } from "tedious";
import { closeConnection, createServiceConnection, executeQuery } from "../db";
import { Sentry } from "../sentry";
import {
  syncJobAwaitingAccounts,
  syncJobAwaitingFacilitiesApproval,
  syncJobDirectorApproval,
  syncJobOnchargePending,
  syncJobStalled,
} from "../jobPlannerSync";
import {
  getPlanConfig,
  graphCompletePlannerTask,
  graphCreatePlannerTask,
  graphGetGroupMembers,
  graphGetPlannerTask,
} from "../planner";
import {
  buildJobTaskDescription,
  buildTaskTitle,
  buildTenantTaskDescription,
  computeEventDate,
  escalationThresholdDays,
  getFacilitiesManagerEmails,
  groupPlannerTasksByKey,
  isInWindow,
  LEAD_TIMES,
  plannerTaskKey,
  toIsoDateString,
  type PlannerJobRow,
  type PlannerTaskRowShape,
  type PlannerTenantRow,
  type TriggerType,
} from "../plannerHelpers";
import { graphSendMail } from "../graph";
import { buildJobUrl } from "../email/director-emails";

const TENANT_TRIGGER_TYPES: TriggerType[] = [
  "lease_expiry",
  "option_notice",
  "rent_review",
];

/**
 * Updates LastSyncedAt / LastError / AttemptCount on a PlannerTasks row.
 * Called after every Graph API attempt against an existing row so the UI can
 * show whether the last sync succeeded and surface any error message.
 */
async function recordPlannerSyncOutcome(
  connection: any,
  rowId: number,
  error: string | null,
): Promise<void> {
  await executeQuery(
    connection,
    `UPDATE dbo.PlannerTasks
     SET LastSyncedAt = SYSUTCDATETIME(),
         LastError = @Error,
         AttemptCount = AttemptCount + 1
     WHERE Id = @Id`,
    [
      { name: "Id", type: TYPES.Int, value: rowId },
      {
        name: "Error",
        type: TYPES.NVarChar,
        value: error === null ? null : error.slice(0, 1000),
      },
    ],
  );
}

export async function plannerSyncTimer(
  _timer: Timer,
  context: InvocationContext,
): Promise<void> {
  context.log("plannerSyncTimer: starting");

  const {
    PLANNER_FACILITIES_GROUP_ID,
    PLANNER_FACILITIES_PLAN_ID,
    PLANNER_ACCOUNTS_GROUP_ID,
    PLANNER_ACCOUNTS_PLAN_ID,
    APP_BASE_URL,
  } = process.env;

  if (
    !PLANNER_FACILITIES_GROUP_ID ||
    !PLANNER_FACILITIES_PLAN_ID ||
    !PLANNER_ACCOUNTS_GROUP_ID ||
    !PLANNER_ACCOUNTS_PLAN_ID ||
    !APP_BASE_URL
  ) {
    context.error("plannerSyncTimer: missing Facilities or Accounts plan env vars — skipping");
    return;
  }

  let connection;
  try {
    const [facilitiesMembers, accountsMembers] = await Promise.all([
      graphGetGroupMembers(PLANNER_FACILITIES_GROUP_ID),
      graphGetGroupMembers(PLANNER_ACCOUNTS_GROUP_ID),
    ]);
    context.log(
      `plannerSyncTimer: facilities=${facilitiesMembers.length} accounts=${accountsMembers.length} members`,
    );

    connection = await createServiceConnection();
    const today = new Date();

    // ── Tenancy triggers ────────────────────────────────────────────────────

    const tenantRows = await executeQuery(
      connection,
      `SELECT
         t.TenantId,
         t.LegalName,
         t.TradingName,
         COALESCE(b.BuildingName, '') AS BuildingName,
         (SELECT TOP 1 Level + ' / ' + Area
          FROM dbo.TenantOccupancies
          WHERE TenantId = t.TenantId
          ORDER BY Level, Area) AS FirstOccupancy,
         CONVERT(VARCHAR(10), t.Expiry, 120) AS Expiry,
         t.OptionNoticeMonths,
         CONVERT(VARCHAR(10), t.NextReviewDate, 120) AS NextReviewDate,
         t.ReviewType
       FROM dbo.Tenants t
       LEFT JOIN dbo.Buildings b ON b.BuildingID = t.BuildingId
       WHERE t.Status NOT IN ('vacated')
         AND (t.Expiry IS NOT NULL OR t.NextReviewDate IS NOT NULL)`,
    );

    const tenants: PlannerTenantRow[] = tenantRows.map((r) => ({
      tenantId: r.TenantId as number,
      legalName: r.LegalName as string,
      tradingName: (r.TradingName as string | null) ?? null,
      buildingName: (r.BuildingName as string) ?? "",
      firstOccupancy: (r.FirstOccupancy as string | null) ?? null,
      expiry: (r.Expiry as string | null) ?? null,
      optionNoticeMonths: (r.OptionNoticeMonths as number | null) ?? null,
      nextReviewDate: (r.NextReviewDate as string | null) ?? null,
      reviewType: (r.ReviewType as string | null) ?? null,
    }));

    let created = 0;
    let skipped = 0;
    let recreated = 0;

    // Batched prefetch — one query covers every (tenant × trigger) combo so
    // the inner loop reads from a Map instead of issuing per-iteration SELECTs.
    // Bound by tenant IDs from this run + the fixed TENANT_TRIGGER_TYPES list.
    const tenantIds = tenants.map((t) => t.tenantId);
    const tenantTaskRows = tenantIds.length === 0
      ? []
      : await executeQuery(
          connection,
          `SELECT EntityType, EntityId, TriggerType, LeadTimeDays,
                  Id, PlannerTaskId, Status
           FROM dbo.PlannerTasks
           WHERE EntityType = 'tenant'
             AND EntityId IN (${tenantIds.map((_, i) => `@TenantId${i}`).join(",")})
             AND TriggerType IN (${TENANT_TRIGGER_TYPES.map((_, i) => `@TriggerType${i}`).join(",")})`,
          [
            ...tenantIds.map((id, i) => ({ name: `TenantId${i}`, type: TYPES.Int, value: id })),
            ...TENANT_TRIGGER_TYPES.map((t, i) => ({ name: `TriggerType${i}`, type: TYPES.NVarChar, value: t })),
          ],
        );
    const tenantTaskByKey = groupPlannerTasksByKey(tenantTaskRows as PlannerTaskRowShape[]);

    for (const tenant of tenants) {
      for (const triggerType of TENANT_TRIGGER_TYPES) {
        const eventDate = computeEventDate(tenant, triggerType);
        if (!eventDate) continue;

        for (const leadTimeDays of LEAD_TIMES) {
          if (!isInWindow(today, eventDate, leadTimeDays)) continue;

          const existingRow = tenantTaskByKey.get(plannerTaskKey({
            entityType: "tenant",
            entityId: tenant.tenantId,
            triggerType,
            leadTimeDays,
          }));
          const existing = existingRow ? [existingRow] : [];

          const displayName = tenant.tradingName ?? tenant.legalName;
          const title = buildTaskTitle(displayName, triggerType, leadTimeDays);
          const description = buildTenantTaskDescription(
            tenant,
            triggerType,
            APP_BASE_URL,
          );
          const dueDateStr = toIsoDateString(eventDate);
          const { planId, bucketId } = getPlanConfig(triggerType);

          if (existing.length === 0) {
            try {
              const taskId = await graphCreatePlannerTask({
                planId,
                bucketId,
                title,
                dueDate: dueDateStr,
                assigneeIds: accountsMembers,
                description,
              });
              await executeQuery(
                connection,
                `INSERT INTO dbo.PlannerTasks
                   (EntityType, EntityId, TriggerType, LeadTimeDays, PlannerTaskId, DueDate, PlanType,
                    LastSyncedAt, LastError, AttemptCount)
                 VALUES ('tenant', @EntityId, @TriggerType, @LeadTimeDays, @TaskId, @DueDate, 'accounts',
                         SYSUTCDATETIME(), NULL, 1)`,
                [
                  { name: "EntityId", type: TYPES.Int, value: tenant.tenantId },
                  {
                    name: "TriggerType",
                    type: TYPES.NVarChar,
                    value: triggerType,
                  },
                  {
                    name: "LeadTimeDays",
                    type: TYPES.Int,
                    value: leadTimeDays,
                  },
                  { name: "TaskId", type: TYPES.NVarChar, value: taskId },
                  {
                    name: "DueDate",
                    type: TYPES.Date,
                    value: new Date(dueDateStr),
                  },
                ],
              );
              created++;
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              context.error(
                `plannerSyncTimer: failed to create task for tenant ${tenant.tenantId} ${triggerType} ${leadTimeDays}d:`,
                message,
              );
            }
            continue;
          }

          const row = existing[0];
          const rowId = row.Id as number;
          const plannerTaskId = row.PlannerTaskId as string;
          const rowStatus = row.Status as string;

          if (rowStatus === "resolved") {
            try {
              const taskId = await graphCreatePlannerTask({
                planId,
                bucketId,
                title,
                dueDate: dueDateStr,
                assigneeIds: accountsMembers,
                description,
              });
              await executeQuery(
                connection,
                `UPDATE dbo.PlannerTasks
                 SET PlannerTaskId = @TaskId, Status = 'active',
                     DueDate = @DueDate, ResolvedAt = NULL,
                     LastSyncedAt = SYSUTCDATETIME(), LastError = NULL,
                     AttemptCount = AttemptCount + 1
                 WHERE Id = @Id`,
                [
                  { name: "TaskId", type: TYPES.NVarChar, value: taskId },
                  {
                    name: "DueDate",
                    type: TYPES.Date,
                    value: new Date(dueDateStr),
                  },
                  { name: "Id", type: TYPES.Int, value: rowId },
                ],
              );
              recreated++;
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              context.error(
                `plannerSyncTimer: failed to recreate task for tenant ${tenant.tenantId}:`,
                message,
              );
              await recordPlannerSyncOutcome(connection, rowId, message);
            }
            continue;
          }

          try {
            const task = await graphGetPlannerTask(plannerTaskId);
            if (task !== null) {
              skipped++;
              await recordPlannerSyncOutcome(connection, rowId, null);
            } else {
              const taskId = await graphCreatePlannerTask({
                planId,
                bucketId,
                title,
                dueDate: dueDateStr,
                assigneeIds: accountsMembers,
                description,
              });
              await executeQuery(
                connection,
                `UPDATE dbo.PlannerTasks
                 SET PlannerTaskId = @TaskId, DueDate = @DueDate,
                     LastSyncedAt = SYSUTCDATETIME(), LastError = NULL,
                     AttemptCount = AttemptCount + 1
                 WHERE Id = @Id`,
                [
                  { name: "TaskId", type: TYPES.NVarChar, value: taskId },
                  {
                    name: "DueDate",
                    type: TYPES.Date,
                    value: new Date(dueDateStr),
                  },
                  { name: "Id", type: TYPES.Int, value: rowId },
                ],
              );
              recreated++;
            }
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            context.error(
              `plannerSyncTimer: error checking task ${plannerTaskId}:`,
              message,
            );
            await recordPlannerSyncOutcome(connection, rowId, message);
          }
        }
      }
    }
    context.log(
      `plannerSyncTimer: tenancy — created=${created} skipped=${skipped} recreated=${recreated}`,
    );

    // ── Job update_due trigger ──────────────────────────────────────────────

    const jobRows = await executeQuery(
      connection,
      `SELECT j.JobID, j.Title,
              COALESCE(b.BuildingName, '') AS BuildingName,
              CONVERT(VARCHAR(23), j.ExpectedProgressUpdate, 126) AS ExpectedProgressUpdate
       FROM Jobs j
       LEFT JOIN dbo.Buildings b ON b.BuildingID = j.BuildingID
       WHERE j.IsArchived = 0
         AND j.Status <> 'Done'
         AND j.ExpectedProgressUpdate IS NOT NULL
         -- Sargable form: compare the indexed column directly to the start of
         -- tomorrow (UTC). Including everything strictly before tomorrow gives
         -- us "today or earlier" without wrapping the column in CAST.
         AND j.ExpectedProgressUpdate < DATEADD(DAY, 1, CAST(SYSUTCDATETIME() AS DATE))`,
    );

    const jobs: PlannerJobRow[] = jobRows.map((r) => ({
      jobId: r.JobID as number,
      title: r.Title as string,
      buildingName: (r.BuildingName as string | null) ?? null,
      expectedProgressUpdate: (r.ExpectedProgressUpdate as string | null) ?? null,
    }));

    let jobCreated = 0;
    let jobSkipped = 0;

    // Batched prefetch for the job_update_due trigger. One query covers
    // every job from this run.
    const jobIds = jobs.map((j) => j.jobId);
    const jobTaskRows = jobIds.length === 0
      ? []
      : await executeQuery(
          connection,
          `SELECT EntityType, EntityId, TriggerType, LeadTimeDays,
                  Id, PlannerTaskId, Status
           FROM dbo.PlannerTasks
           WHERE EntityType = 'job'
             AND TriggerType = 'job_update_due'
             AND LeadTimeDays = 0
             AND EntityId IN (${jobIds.map((_, i) => `@JobId${i}`).join(",")})`,
          jobIds.map((id, i) => ({ name: `JobId${i}`, type: TYPES.Int, value: id })),
        );
    const jobTaskByKey = groupPlannerTasksByKey(jobTaskRows as PlannerTaskRowShape[]);

    for (const job of jobs) {
      const existingRow = jobTaskByKey.get(plannerTaskKey({
        entityType: "job",
        entityId: job.jobId,
        triggerType: "job_update_due",
        leadTimeDays: 0,
      }));
      const existing = existingRow ? [existingRow] : [];

      const title = buildTaskTitle(job.title, "job_update_due", 0);
      const description = buildJobTaskDescription(job, APP_BASE_URL);
      const dueDateStr = job.expectedProgressUpdate
        ? toIsoDateString(new Date(job.expectedProgressUpdate))
        : toIsoDateString(today);
      const { planId: jobPlanId, bucketId: jobBucketId } = getPlanConfig("job_update_due");

      if (existing.length === 0) {
        try {
          const taskId = await graphCreatePlannerTask({
            planId: jobPlanId,
            bucketId: jobBucketId,
            title,
            dueDate: dueDateStr,
            assigneeIds: facilitiesMembers,
            description,
          });
          await executeQuery(
            connection,
            `INSERT INTO dbo.PlannerTasks
               (EntityType, EntityId, TriggerType, LeadTimeDays, PlannerTaskId, DueDate, PlanType,
                LastSyncedAt, LastError, AttemptCount)
             VALUES ('job', @EntityId, 'job_update_due', 0, @TaskId, @DueDate, 'facilities',
                     SYSUTCDATETIME(), NULL, 1)`,
            [
              { name: "EntityId", type: TYPES.Int, value: job.jobId },
              { name: "TaskId", type: TYPES.NVarChar, value: taskId },
              { name: "DueDate", type: TYPES.Date, value: new Date(dueDateStr) },
            ],
          );
          jobCreated++;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          context.error(
            `plannerSyncTimer: failed to create job task for JobID ${job.jobId}:`,
            message,
          );
        }
        continue;
      }

      const row = existing[0];
      const rowId = row.Id as number;
      const rowStatus = row.Status as string;

      if (rowStatus === "active") {
        try {
          const task = await graphGetPlannerTask(row.PlannerTaskId as string);
          if (task !== null) {
            jobSkipped++;
            await recordPlannerSyncOutcome(connection, rowId, null);
          } else {
            const taskId = await graphCreatePlannerTask({
              planId: jobPlanId,
              bucketId: jobBucketId,
              title,
              dueDate: dueDateStr,
              assigneeIds: facilitiesMembers,
              description,
            });
            await executeQuery(
              connection,
              `UPDATE dbo.PlannerTasks
               SET PlannerTaskId = @TaskId,
                   LastSyncedAt = SYSUTCDATETIME(), LastError = NULL,
                   AttemptCount = AttemptCount + 1
               WHERE Id = @Id`,
              [
                { name: "TaskId", type: TYPES.NVarChar, value: taskId },
                { name: "Id", type: TYPES.Int, value: rowId },
              ],
            );
            jobCreated++;
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          context.error(
            `plannerSyncTimer: error checking job task ${row.PlannerTaskId}:`,
            message,
          );
          await recordPlannerSyncOutcome(connection, rowId, message);
        }
      } else {
        try {
          const taskId = await graphCreatePlannerTask({
            planId: jobPlanId,
            bucketId: jobBucketId,
            title,
            dueDate: dueDateStr,
            assigneeIds: facilitiesMembers,
            description,
          });
          await executeQuery(
            connection,
            `UPDATE dbo.PlannerTasks
             SET PlannerTaskId = @TaskId, Status = 'active',
                 DueDate = @DueDate, ResolvedAt = NULL,
                 LastSyncedAt = SYSUTCDATETIME(), LastError = NULL,
                 AttemptCount = AttemptCount + 1
             WHERE Id = @Id`,
            [
              { name: "TaskId", type: TYPES.NVarChar, value: taskId },
              { name: "DueDate", type: TYPES.Date, value: new Date(dueDateStr) },
              { name: "Id", type: TYPES.Int, value: rowId },
            ],
          );
          jobCreated++;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          context.error(
            `plannerSyncTimer: failed to recreate job task for JobID ${job.jobId}:`,
            message,
          );
          await recordPlannerSyncOutcome(connection, rowId, message);
        }
      }
    }
    context.log(
      `plannerSyncTimer: jobs — created=${jobCreated} skipped=${jobSkipped}`,
    );

    // ── Stalled jobs (Facilities plan) ─────────────────────────────────────
    // Reconciliation sweep — eager fire happens from upsertJob; this catches
    // missed fires + auto-resolves jobs whose IsStalled flag flipped off.

    const stalledRows = await executeQuery(
      connection,
      `SELECT DISTINCT j.JobID
       FROM dbo.Jobs j
       LEFT JOIN dbo.PlannerTasks pt
         ON pt.EntityType = 'job' AND pt.EntityId = j.JobID
        AND pt.TriggerType = 'stalled_facilities'
       WHERE (j.IsStalled = 1 AND j.IsArchived = 0 AND j.Status <> 'Done'
              AND (j.AwaitingRole IS NULL OR j.AwaitingRole = 'facilities'))
          OR (pt.Status = 'active')`,
    );

    let stalledProcessed = 0;
    let stalledErrors = 0;
    for (const r of stalledRows) {
      const jobId = r.JobID as number;
      try {
        await syncJobStalled(jobId, {
          connection,
          facilitiesMembers,
          appBaseUrl: APP_BASE_URL,
          log: (msg) => context.log(msg),
        });
        stalledProcessed++;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        context.error(`plannerSyncTimer: stalled_facilities failed for JobID ${jobId}:`, message);
        Sentry.captureException(err, {
          tags: { source: "planner_sync_timer", trigger: "stalled_facilities", jobId: String(jobId) },
        });
        stalledErrors++;
      }
    }
    context.log(`plannerSyncTimer: stalled_facilities — processed=${stalledProcessed} errors=${stalledErrors}`);

    // ── Awaiting accounts (Accounts plan) ──────────────────────────────────
    // Reconciliation sweep — eager fire happens from upsertJob; this catches
    // missed fires + auto-resolves jobs whose AwaitingRole flipped away from
    // 'accounts' without us being notified.

    const awaitingRows = await executeQuery(
      connection,
      `SELECT DISTINCT j.JobID
       FROM dbo.Jobs j
       LEFT JOIN dbo.PlannerTasks pt
         ON pt.EntityType = 'job' AND pt.EntityId = j.JobID
        AND pt.TriggerType = 'awaiting_accounts'
       WHERE (j.IsArchived = 0 AND j.Status <> 'Done' AND j.AwaitingRole = 'accounts')
          OR (pt.Status = 'active')`,
    );

    let awaitingProcessed = 0;
    let awaitingErrors = 0;
    for (const r of awaitingRows) {
      const jobId = r.JobID as number;
      try {
        await syncJobAwaitingAccounts(jobId, {
          connection,
          accountsMembers,
          appBaseUrl: APP_BASE_URL,
          log: (msg) => context.log(msg),
        });
        awaitingProcessed++;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        context.error(`plannerSyncTimer: awaiting_accounts failed for JobID ${jobId}:`, message);
        Sentry.captureException(err, {
          tags: { source: "planner_sync_timer", trigger: "awaiting_accounts", jobId: String(jobId) },
        });
        awaitingErrors++;
      }
    }
    context.log(`plannerSyncTimer: awaiting_accounts — processed=${awaitingProcessed} errors=${awaitingErrors}`);

    // ── Awaiting facilities approval (Facilities plan) ─────────────────────
    // Reconciliation sweep — eager fire happens from addQuote (quote received
    // moves the job to Awaiting Approval/facilities) and upsertJob; this catches
    // missed fires + auto-resolves jobs that left (Awaiting Approval, facilities)
    // without us being notified.

    const awaitingFacilitiesRows = await executeQuery(
      connection,
      `SELECT DISTINCT j.JobID
       FROM dbo.Jobs j
       LEFT JOIN dbo.PlannerTasks pt
         ON pt.EntityType = 'job' AND pt.EntityId = j.JobID
        AND pt.TriggerType = 'awaiting_facilities_approval'
       WHERE (j.IsArchived = 0 AND j.Status = 'Awaiting Approval' AND j.AwaitingRole = 'facilities')
          OR (pt.Status = 'active')`,
    );

    let awaitingFacilitiesProcessed = 0;
    let awaitingFacilitiesErrors = 0;
    for (const r of awaitingFacilitiesRows) {
      const jobId = r.JobID as number;
      try {
        await syncJobAwaitingFacilitiesApproval(jobId, {
          connection,
          facilitiesMembers,
          appBaseUrl: APP_BASE_URL,
          log: (msg) => context.log(msg),
        });
        awaitingFacilitiesProcessed++;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        context.error(`plannerSyncTimer: awaiting_facilities_approval failed for JobID ${jobId}:`, message);
        Sentry.captureException(err, {
          tags: { source: "planner_sync_timer", trigger: "awaiting_facilities_approval", jobId: String(jobId) },
        });
        awaitingFacilitiesErrors++;
      }
    }
    context.log(`plannerSyncTimer: awaiting_facilities_approval — processed=${awaitingFacilitiesProcessed} errors=${awaitingFacilitiesErrors}`);

    // ── Director approval (Accounts plan) ──────────────────────────────────
    // Reconciliation sweep — eager fires happen from approveJobInvoice and
    // approveQuote (create) + directorApproveJobInvoice / directorApproveQuote
    // (resolve). This catches missed fires and reject/undo/delete transitions
    // that aren't eagerly wired (Option A scope — low-traffic edge paths).

    const directorRows = await executeQuery(
      connection,
      `SELECT DISTINCT j.JobID
       FROM dbo.Jobs j
       LEFT JOIN dbo.PlannerTasks pt
         ON pt.EntityType = 'job' AND pt.EntityId = j.JobID
        AND pt.TriggerType = 'director_approval'
       WHERE (
              j.IsArchived = 0 AND j.Status <> 'Done' AND (
                EXISTS (SELECT 1 FROM dbo.JobInvoices ji
                        WHERE ji.JobID = j.JobID AND ji.Status = 'approved')
                OR EXISTS (SELECT 1 FROM dbo.Quotes q
                           WHERE q.JobID = j.JobID AND q.Status = 'awaiting_director')
              )
            )
          OR (pt.Status = 'active')`,
    );

    let directorProcessed = 0;
    let directorErrors = 0;
    for (const r of directorRows) {
      const jobId = r.JobID as number;
      try {
        await syncJobDirectorApproval(jobId, {
          connection,
          accountsMembers,
          appBaseUrl: APP_BASE_URL,
          log: (msg) => context.log(msg),
        });
        directorProcessed++;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        context.error(`plannerSyncTimer: director_approval failed for JobID ${jobId}:`, message);
        Sentry.captureException(err, {
          tags: { source: "planner_sync_timer", trigger: "director_approval", jobId: String(jobId) },
        });
        directorErrors++;
      }
    }
    context.log(`plannerSyncTimer: director_approval — processed=${directorProcessed} errors=${directorErrors}`);

    // ── Oncharge pending (Accounts plan) ───────────────────────────────────
    // Reconciliation sweep — primary trigger is the eager fire from upsertJob
    // and outgoing-invoice insert. Here we just re-check every job that might
    // need a task created or resolved, in case the eager call was skipped or
    // failed.

    const onchargeRows = await executeQuery(
      connection,
      `SELECT DISTINCT j.JobID
       FROM dbo.Jobs j
       LEFT JOIN dbo.PlannerTasks pt
         ON pt.EntityType = 'job' AND pt.EntityId = j.JobID
        AND pt.TriggerType = 'oncharge_pending'
       WHERE (j.IsOnchargeable = 1 AND j.IsArchived = 0 AND j.Status <> 'Done')
          OR (pt.Status = 'active')`,
    );

    let onchargeProcessed = 0;
    let onchargeErrors = 0;
    for (const r of onchargeRows) {
      const jobId = r.JobID as number;
      try {
        await syncJobOnchargePending(jobId, {
          connection,
          accountsMembers,
          appBaseUrl: APP_BASE_URL,
          log: (msg) => context.log(msg),
        });
        onchargeProcessed++;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        context.error(`plannerSyncTimer: oncharge_pending failed for JobID ${jobId}:`, message);
        Sentry.captureException(err, {
          tags: { source: "planner_sync_timer", trigger: "oncharge_pending", jobId: String(jobId) },
        });
        onchargeErrors++;
      }
    }
    context.log(`plannerSyncTimer: oncharge_pending — processed=${onchargeProcessed} errors=${onchargeErrors}`);

    // ── Resolve overdue tasks ───────────────────────────────────────────────

    const overdue = await executeQuery(
      connection,
      `SELECT Id, PlannerTaskId
       FROM dbo.PlannerTasks
       WHERE Status = 'active'
         AND DueDate < CAST(SYSUTCDATETIME() AS DATE)`,
    );

    // Phase 1: Graph completes per-row (each task has its own etag).
    // Phase 2: collected successes get marked resolved in a single batched
    // UPDATE — eliminates one round-trip per overdue task on the happy path.
    // Failures stay per-row because recordPlannerSyncOutcome writes the error
    // message into LastError, which differs per row.
    const resolvedIds: number[] = [];
    for (const row of overdue) {
      const rowId = row.Id as number;
      const plannerTaskId = row.PlannerTaskId as string;
      try {
        const task = await graphGetPlannerTask(plannerTaskId);
        if (task) {
          await graphCompletePlannerTask(plannerTaskId, task.etag);
        }
        resolvedIds.push(rowId);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        context.error(
          `plannerSyncTimer: failed to resolve overdue task ${plannerTaskId}:`,
          message,
        );
        await recordPlannerSyncOutcome(connection, rowId, message);
      }
    }

    if (resolvedIds.length > 0) {
      await executeQuery(
        connection,
        `UPDATE dbo.PlannerTasks
         SET Status = 'resolved', ResolvedAt = SYSUTCDATETIME(),
             LastSyncedAt = SYSUTCDATETIME(), LastError = NULL,
             AttemptCount = AttemptCount + 1
         WHERE Id IN (${resolvedIds.map((_, i) => `@Id${i}`).join(",")})`,
        resolvedIds.map((id, i) => ({ name: `Id${i}`, type: TYPES.Int, value: id })),
      );
    }
    const resolved = resolvedIds.length;
    context.log(`plannerSyncTimer: resolved ${resolved} overdue tasks`);

    // ── Escalation evaluator (WP18a) ───────────────────────────────────────
    // Once per day (this 02:30 run): assigned, non-archived, non-terminal jobs
    // whose next action is still pending — (Awaiting Approval, *) needing a
    // sign-off, OR New/Quote/Work needing the assignee to move it — that have
    // NOT been escalated yet (EscalatedAt IS NULL) and have aged past their
    // priority threshold since the later of last acknowledgement / status change
    // / creation. For each: email the facilities managers and stamp EscalatedAt
    // so it fires exactly once (cleared on the next ack / transition). The
    // threshold is per-priority and env-derived, so the age compare happens in
    // JS; SQL only narrows to the static candidate set.
    //
    // FACILITIES_MANAGER_EMAILS unset → recipients empty → we skip the send but
    // STILL stamp EscalatedAt (documented choice: the job is escalated in the
    // dashboard via EscalatedAt regardless; re-firing daily emails once the env
    // is later configured would be noise for a backlog that's already surfaced).
    const escalationRecipients = getFacilitiesManagerEmails();
    const escalationCandidates = await executeQuery(
      connection,
      `SELECT j.JobID, j.Title, j.Priority,
              DATEDIFF(DAY, COALESCE(j.AcknowledgedAt, j.StatusSince, j.CreatedAt),
                       SYSUTCDATETIME()) AS AgeDays
       FROM dbo.Jobs j
       WHERE j.AssignedToUserID IS NOT NULL
         AND j.IsArchived = 0
         AND j.Status <> 'Done'
         AND j.EscalatedAt IS NULL
         AND (
              (j.Status = 'Awaiting Approval')
           OR (j.Status IN ('New', 'Quote', 'Work'))
         )`,
    );

    let escalated = 0;
    let escalationErrors = 0;
    for (const r of escalationCandidates) {
      const jobId = r.JobID as number;
      const priority = (r.Priority as string | null) ?? null;
      const ageDays = (r.AgeDays as number | null) ?? 0;
      if (ageDays <= escalationThresholdDays(priority)) continue;

      try {
        if (escalationRecipients.length > 0) {
          const title = (r.Title as string | null) ?? `Job #${jobId}`;
          const jobUrl = buildJobUrl(jobId);
          const linkLine = jobUrl
            ? `Open in Command Centre: ${jobUrl}`
            : "Open the job in Command Centre.";
          const subject = `Job escalation — #${jobId} unactioned for ${ageDays} days`;
          const body =
`Hi,

Job #${jobId} has been waiting on action for ${ageDays} day${ageDays === 1 ? "" : "s"} without acknowledgement and needs a manager's attention.

Job: ${title}
Priority: ${priority ?? "—"}
Age since last update: ${ageDays} day${ageDays === 1 ? "" : "s"}

${linkLine}
`;
          // Fire-and-forget per the existing email pattern: a Graph failure must
          // not abort the sweep. Wrap each send so one bad recipient/job doesn't
          // block the rest.
          await graphSendMail(escalationRecipients, subject, body.trim() + "\n");
        } else {
          context.warn(
            `plannerSyncTimer: FACILITIES_MANAGER_EMAILS unset — escalating JobID ${jobId} without email (dashboard only)`,
          );
        }
        // Stamp once so this job won't re-escalate until its clock resets.
        await executeQuery(
          connection,
          `UPDATE dbo.Jobs SET EscalatedAt = SYSUTCDATETIME() WHERE JobID = @JobID`,
          [{ name: "JobID", type: TYPES.Int, value: jobId }],
        );
        escalated++;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        context.warn(`plannerSyncTimer: escalation failed for JobID ${jobId}: ${message}`);
        Sentry.captureException(err, {
          tags: { source: "planner_sync_timer", trigger: "escalation", jobId: String(jobId) },
        });
        escalationErrors++;
      }
    }
    context.log(`plannerSyncTimer: escalation — escalated=${escalated} errors=${escalationErrors}`);

    context.log("plannerSyncTimer: complete");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("plannerSyncTimer: fatal:", message);
    Sentry.captureException(error, { tags: { source: "planner_sync_timer", scope: "fatal" } });
    throw error;
  } finally {
    if (connection) closeConnection(connection);
    // Timer invocations don't propagate caught errors to the runtime, so the
    // global postInvocation hook in startup.ts won't auto-flush Sentry. Flush
    // explicitly so per-job captures from the sweeps actually leave the worker
    // before the next idle teardown.
    await Sentry.flush(2000);
  }
}

app.timer("plannerSyncTimer", {
  schedule: "0 30 2 * * *",
  handler: plannerSyncTimer,
});
