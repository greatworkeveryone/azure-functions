import { app, type InvocationContext, type Timer } from "@azure/functions";
import { TYPES } from "tedious";
import { closeConnection, createServiceConnection, executeQuery } from "../db";
import {
  getPlanConfig,
  graphCompletePlannerTask,
  graphCreatePlannerTask,
  graphGetGroupMembers,
  graphGetPlannerTask,
} from "../planner";
import {
  addDaysUTC,
  buildAwaitingAccountsTaskDescription,
  buildDirectorApprovalTaskDescription,
  buildJobTaskDescription,
  buildStalledJobTaskDescription,
  buildTaskTitle,
  buildTenantTaskDescription,
  computeEventDate,
  isInWindow,
  LEAD_TIMES,
  toIsoDateString,
  type PlannerAccountsJobRow,
  type PlannerJobRow,
  type PlannerStalledJobRow,
  type PlannerTenantRow,
  type TriggerType,
} from "../plannerHelpers";

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

    for (const tenant of tenants) {
      for (const triggerType of TENANT_TRIGGER_TYPES) {
        const eventDate = computeEventDate(tenant, triggerType);
        if (!eventDate) continue;

        for (const leadTimeDays of LEAD_TIMES) {
          if (!isInWindow(today, eventDate, leadTimeDays)) continue;

          const existing = await executeQuery(
            connection,
            `SELECT Id, PlannerTaskId, Status
             FROM dbo.PlannerTasks
             WHERE EntityType = 'tenant'
               AND EntityId = @EntityId
               AND TriggerType = @TriggerType
               AND LeadTimeDays = @LeadTimeDays`,
            [
              { name: "EntityId", type: TYPES.Int, value: tenant.tenantId },
              { name: "TriggerType", type: TYPES.NVarChar, value: triggerType },
              { name: "LeadTimeDays", type: TYPES.Int, value: leadTimeDays },
            ],
          );

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
         AND CAST(j.ExpectedProgressUpdate AS DATE) <= CAST(SYSUTCDATETIME() AS DATE)`,
    );

    const jobs: PlannerJobRow[] = jobRows.map((r) => ({
      jobId: r.JobID as number,
      title: r.Title as string,
      buildingName: (r.BuildingName as string | null) ?? null,
      expectedProgressUpdate: (r.ExpectedProgressUpdate as string | null) ?? null,
    }));

    let jobCreated = 0;
    let jobSkipped = 0;

    for (const job of jobs) {
      const existing = await executeQuery(
        connection,
        `SELECT Id, PlannerTaskId, Status
         FROM dbo.PlannerTasks
         WHERE EntityType = 'job'
           AND EntityId = @EntityId
           AND TriggerType = 'job_update_due'
           AND LeadTimeDays = 0`,
        [{ name: "EntityId", type: TYPES.Int, value: job.jobId }],
      );

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
               (EntityType, EntityId, TriggerType, LeadTimeDays, PlannerTaskId, DueDate, PlanType)
             VALUES ('job', @EntityId, 'job_update_due', 0, @TaskId, @DueDate, 'facilities')`,
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
      const rowStatus = row.Status as string;

      if (rowStatus === "active") {
        try {
          const task = await graphGetPlannerTask(row.PlannerTaskId as string);
          if (task !== null) {
            jobSkipped++;
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
              `UPDATE dbo.PlannerTasks SET PlannerTaskId = @TaskId WHERE Id = @Id`,
              [
                { name: "TaskId", type: TYPES.NVarChar, value: taskId },
                { name: "Id", type: TYPES.Int, value: row.Id as number },
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
                 DueDate = @DueDate, ResolvedAt = NULL
             WHERE Id = @Id`,
            [
              { name: "TaskId", type: TYPES.NVarChar, value: taskId },
              { name: "DueDate", type: TYPES.Date, value: new Date(dueDateStr) },
              { name: "Id", type: TYPES.Int, value: row.Id as number },
            ],
          );
          jobCreated++;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          context.error(
            `plannerSyncTimer: failed to recreate job task for JobID ${job.jobId}:`,
            message,
          );
        }
      }
    }
    context.log(
      `plannerSyncTimer: jobs — created=${jobCreated} skipped=${jobSkipped}`,
    );

    // ── Stalled jobs (Facilities plan) ─────────────────────────────────────

    const stalledRows = await executeQuery(
      connection,
      `SELECT j.JobID, j.Title,
              COALESCE(b.BuildingName, '') AS BuildingName,
              CONVERT(VARCHAR(23), j.StalledAt, 126) AS StalledAt,
              au.EntraOid AS AssignedToEntraOid
       FROM dbo.Jobs j
       LEFT JOIN dbo.Buildings b ON b.BuildingID = j.BuildingID
       LEFT JOIN dbo.AppUsers au ON au.UserID = j.AssignedToUserID
       WHERE j.IsStalled = 1
         AND j.IsArchived = 0
         AND j.Status <> 'Done'
         AND (j.AwaitingRole IS NULL OR j.AwaitingRole = 'facilities')`,
    );

    const stalledJobs: PlannerStalledJobRow[] = stalledRows.map((r) => ({
      jobId: r.JobID as number,
      title: r.Title as string,
      buildingName: (r.BuildingName as string | null) ?? null,
      stalledAt: (r.StalledAt as string | null) ?? null,
      assignedToEntraOid: (r.AssignedToEntraOid as string | null) ?? null,
    }));

    let stalledCreated = 0;
    let stalledSkipped = 0;

    for (const job of stalledJobs) {
      const existing = await executeQuery(
        connection,
        `SELECT Id, PlannerTaskId, Status
         FROM dbo.PlannerTasks
         WHERE EntityType = 'job' AND EntityId = @EntityId
           AND TriggerType = 'stalled_facilities' AND LeadTimeDays = 0`,
        [{ name: "EntityId", type: TYPES.Int, value: job.jobId }],
      );

      const stalledDate = job.stalledAt ? new Date(job.stalledAt) : new Date();
      const dueDate = addDaysUTC(stalledDate, 2);
      const dueDateStr = toIsoDateString(dueDate);
      const title = buildTaskTitle(job.title, "stalled_facilities", 0);
      const description = buildStalledJobTaskDescription(job, APP_BASE_URL);
      const { planId, bucketId } = getPlanConfig("stalled_facilities");
      const assigneeIds = job.assignedToEntraOid
        ? [job.assignedToEntraOid]
        : facilitiesMembers;

      if (existing.length === 0) {
        try {
          const taskId = await graphCreatePlannerTask({
            planId,
            bucketId,
            title,
            dueDate: dueDateStr,
            assigneeIds,
            description,
          });
          await executeQuery(
            connection,
            `INSERT INTO dbo.PlannerTasks
               (EntityType, EntityId, TriggerType, LeadTimeDays, PlannerTaskId, DueDate, PlanType)
             VALUES ('job', @EntityId, 'stalled_facilities', 0, @TaskId, @DueDate, 'facilities')`,
            [
              { name: "EntityId", type: TYPES.Int,      value: job.jobId },
              { name: "TaskId",   type: TYPES.NVarChar,  value: taskId },
              { name: "DueDate",  type: TYPES.Date,      value: new Date(dueDateStr) },
            ],
          );
          stalledCreated++;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          context.error(
            `plannerSyncTimer: failed to create stalled task for JobID ${job.jobId}:`,
            message,
          );
        }
        continue;
      }

      const row = existing[0];
      if ((row.Status as string) === "active") {
        try {
          const task = await graphGetPlannerTask(row.PlannerTaskId as string);
          if (task !== null) {
            stalledSkipped++;
          } else {
            const taskId = await graphCreatePlannerTask({ planId, bucketId, title, dueDate: dueDateStr, assigneeIds, description });
            await executeQuery(
              connection,
              `UPDATE dbo.PlannerTasks SET PlannerTaskId = @TaskId WHERE Id = @Id`,
              [
                { name: "TaskId", type: TYPES.NVarChar, value: taskId },
                { name: "Id",     type: TYPES.Int,      value: row.Id as number },
              ],
            );
            stalledCreated++;
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          context.error(`plannerSyncTimer: error checking stalled task for JobID ${job.jobId}:`, message);
        }
      } else {
        // resolved — job was re-stalled after being unstalled; re-create
        try {
          const taskId = await graphCreatePlannerTask({ planId, bucketId, title, dueDate: dueDateStr, assigneeIds, description });
          await executeQuery(
            connection,
            `UPDATE dbo.PlannerTasks SET PlannerTaskId = @TaskId, Status = 'active', DueDate = @DueDate, ResolvedAt = NULL WHERE Id = @Id`,
            [
              { name: "TaskId",  type: TYPES.NVarChar, value: taskId },
              { name: "DueDate", type: TYPES.Date,     value: new Date(dueDateStr) },
              { name: "Id",      type: TYPES.Int,      value: row.Id as number },
            ],
          );
          stalledCreated++;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          context.error(`plannerSyncTimer: failed to recreate stalled task for JobID ${job.jobId}:`, message);
        }
      }
    }
    context.log(`plannerSyncTimer: stalled — created=${stalledCreated} skipped=${stalledSkipped}`);

    // ── Awaiting accounts (Accounts plan) ──────────────────────────────────

    const awaitingRows = await executeQuery(
      connection,
      `SELECT j.JobID, j.Title,
              COALESCE(b.BuildingName, '') AS BuildingName
       FROM dbo.Jobs j
       LEFT JOIN dbo.Buildings b ON b.BuildingID = j.BuildingID
       WHERE j.IsArchived = 0
         AND j.Status <> 'Done'
         AND j.AwaitingRole = 'accounts'`,
    );

    const awaitingJobs: PlannerAccountsJobRow[] = awaitingRows.map((r) => ({
      jobId: r.JobID as number,
      title: r.Title as string,
      buildingName: (r.BuildingName as string | null) ?? null,
    }));

    let awaitingCreated = 0;
    let awaitingSkipped = 0;

    for (const job of awaitingJobs) {
      const existing = await executeQuery(
        connection,
        `SELECT Id, PlannerTaskId, Status FROM dbo.PlannerTasks
         WHERE EntityType = 'job' AND EntityId = @EntityId
           AND TriggerType = 'awaiting_accounts' AND LeadTimeDays = 0`,
        [{ name: "EntityId", type: TYPES.Int, value: job.jobId }],
      );

      const dueDateStr = toIsoDateString(new Date());
      const title = buildTaskTitle(job.title, "awaiting_accounts", 0);
      const description = buildAwaitingAccountsTaskDescription(job, APP_BASE_URL);
      const { planId, bucketId } = getPlanConfig("awaiting_accounts");

      if (existing.length === 0) {
        try {
          const taskId = await graphCreatePlannerTask({
            planId, bucketId, title, dueDate: dueDateStr,
            assigneeIds: accountsMembers, description,
          });
          await executeQuery(
            connection,
            `INSERT INTO dbo.PlannerTasks
               (EntityType, EntityId, TriggerType, LeadTimeDays, PlannerTaskId, DueDate, PlanType)
             VALUES ('job', @EntityId, 'awaiting_accounts', 0, @TaskId, @DueDate, 'accounts')`,
            [
              { name: "EntityId", type: TYPES.Int,     value: job.jobId },
              { name: "TaskId",   type: TYPES.NVarChar, value: taskId },
              { name: "DueDate",  type: TYPES.Date,     value: new Date(dueDateStr) },
            ],
          );
          awaitingCreated++;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          context.error(`plannerSyncTimer: failed to create awaiting_accounts task for JobID ${job.jobId}:`, message);
        }
        continue;
      }

      if ((existing[0].Status as string) === "active") {
        try {
          const task = await graphGetPlannerTask(existing[0].PlannerTaskId as string);
          if (task !== null) { awaitingSkipped++; }
        } catch (err: unknown) {
          context.error(`plannerSyncTimer: error checking awaiting task ${job.jobId}:`, String(err));
        }
      } else {
        // resolved — awaiting role was set back to accounts; re-create
        try {
          const taskId = await graphCreatePlannerTask({ planId, bucketId, title, dueDate: dueDateStr, assigneeIds: accountsMembers, description });
          await executeQuery(
            connection,
            `UPDATE dbo.PlannerTasks SET PlannerTaskId = @TaskId, Status = 'active', DueDate = @DueDate, ResolvedAt = NULL WHERE Id = @Id`,
            [
              { name: "TaskId",  type: TYPES.NVarChar, value: taskId },
              { name: "DueDate", type: TYPES.Date,     value: new Date(dueDateStr) },
              { name: "Id",      type: TYPES.Int,      value: existing[0].Id as number },
            ],
          );
          awaitingCreated++;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          context.error(`plannerSyncTimer: failed to recreate awaiting task for JobID ${job.jobId}:`, message);
        }
      }
    }
    context.log(`plannerSyncTimer: awaiting_accounts — created=${awaitingCreated} skipped=${awaitingSkipped}`);

    // ── Director approval (Accounts plan) ──────────────────────────────────

    const directorRows = await executeQuery(
      connection,
      `SELECT sub.JobID, sub.Title, sub.BuildingName
       FROM (
         SELECT j.JobID, j.Title,
                COALESCE(b.BuildingName, '') AS BuildingName,
                (SELECT COUNT(*) FROM dbo.JobInvoices ji
                 WHERE ji.JobID = j.JobID AND ji.Status = 'approved') +
                (SELECT COUNT(*) FROM dbo.Quotes q
                 WHERE q.JobID = j.JobID AND q.Status = 'awaiting_director')
                AS DirectorNeededCount
         FROM dbo.Jobs j
         LEFT JOIN dbo.Buildings b ON b.BuildingID = j.BuildingID
         WHERE j.IsArchived = 0 AND j.Status <> 'Done'
       ) sub
       WHERE sub.DirectorNeededCount > 0`,
    );

    const directorJobs: PlannerAccountsJobRow[] = directorRows.map((r) => ({
      jobId: r.JobID as number,
      title: r.Title as string,
      buildingName: (r.BuildingName as string | null) ?? null,
    }));

    let directorCreated = 0;
    let directorSkipped = 0;

    for (const job of directorJobs) {
      const existing = await executeQuery(
        connection,
        `SELECT Id, PlannerTaskId, Status FROM dbo.PlannerTasks
         WHERE EntityType = 'job' AND EntityId = @EntityId
           AND TriggerType = 'director_approval' AND LeadTimeDays = 0`,
        [{ name: "EntityId", type: TYPES.Int, value: job.jobId }],
      );

      const dueDateStr = toIsoDateString(new Date());
      const title = buildTaskTitle(job.title, "director_approval", 0);
      const description = buildDirectorApprovalTaskDescription(job, APP_BASE_URL);
      const { planId, bucketId } = getPlanConfig("director_approval");

      if (existing.length === 0) {
        try {
          const taskId = await graphCreatePlannerTask({
            planId, bucketId, title, dueDate: dueDateStr,
            assigneeIds: accountsMembers, description,
          });
          await executeQuery(
            connection,
            `INSERT INTO dbo.PlannerTasks
               (EntityType, EntityId, TriggerType, LeadTimeDays, PlannerTaskId, DueDate, PlanType)
             VALUES ('job', @EntityId, 'director_approval', 0, @TaskId, @DueDate, 'accounts')`,
            [
              { name: "EntityId", type: TYPES.Int,     value: job.jobId },
              { name: "TaskId",   type: TYPES.NVarChar, value: taskId },
              { name: "DueDate",  type: TYPES.Date,     value: new Date(dueDateStr) },
            ],
          );
          directorCreated++;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          context.error(`plannerSyncTimer: failed to create director_approval task for JobID ${job.jobId}:`, message);
        }
        continue;
      }

      if ((existing[0].Status as string) === "active") {
        try {
          const task = await graphGetPlannerTask(existing[0].PlannerTaskId as string);
          if (task !== null) { directorSkipped++; }
        } catch (err: unknown) {
          context.error(`plannerSyncTimer: error checking director task ${job.jobId}:`, String(err));
        }
      } else {
        // resolved — new invoice/quote requiring director sign-off added; re-create
        try {
          const taskId = await graphCreatePlannerTask({ planId, bucketId, title, dueDate: dueDateStr, assigneeIds: accountsMembers, description });
          await executeQuery(
            connection,
            `UPDATE dbo.PlannerTasks SET PlannerTaskId = @TaskId, Status = 'active', DueDate = @DueDate, ResolvedAt = NULL WHERE Id = @Id`,
            [
              { name: "TaskId",  type: TYPES.NVarChar, value: taskId },
              { name: "DueDate", type: TYPES.Date,     value: new Date(dueDateStr) },
              { name: "Id",      type: TYPES.Int,      value: existing[0].Id as number },
            ],
          );
          directorCreated++;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          context.error(`plannerSyncTimer: failed to recreate director task for JobID ${job.jobId}:`, message);
        }
      }
    }
    context.log(`plannerSyncTimer: director_approval — created=${directorCreated} skipped=${directorSkipped}`);

    // ── Resolve overdue tasks ───────────────────────────────────────────────

    const overdue = await executeQuery(
      connection,
      `SELECT Id, PlannerTaskId
       FROM dbo.PlannerTasks
       WHERE Status = 'active'
         AND DueDate < CAST(SYSUTCDATETIME() AS DATE)`,
    );

    let resolved = 0;
    for (const row of overdue) {
      const rowId = row.Id as number;
      const plannerTaskId = row.PlannerTaskId as string;
      try {
        const task = await graphGetPlannerTask(plannerTaskId);
        if (task) {
          await graphCompletePlannerTask(plannerTaskId, task.etag);
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
        resolved++;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        context.error(
          `plannerSyncTimer: failed to resolve overdue task ${plannerTaskId}:`,
          message,
        );
        await recordPlannerSyncOutcome(connection, rowId, message);
      }
    }
    context.log(`plannerSyncTimer: resolved ${resolved} overdue tasks`);
    context.log("plannerSyncTimer: complete");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("plannerSyncTimer: fatal:", message);
    throw error;
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.timer("plannerSyncTimer", {
  schedule: "0 30 2 * * *",
  handler: plannerSyncTimer,
});
