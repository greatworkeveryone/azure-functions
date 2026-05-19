import { app, type InvocationContext, type Timer } from "@azure/functions";
import { TYPES } from "tedious";
import { closeConnection, createServiceConnection, executeQuery } from "../db";
import {
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
  isInWindow,
  LEAD_TIMES,
  toIsoDateString,
  type PlannerJobRow,
  type PlannerTenantRow,
  type TriggerType,
} from "../plannerHelpers";

const TENANT_TRIGGER_TYPES: TriggerType[] = [
  "lease_expiry",
  "option_notice",
  "rent_review",
];

function bucketIdForTriggerType(triggerType: TriggerType): string {
  const {
    PLANNER_BUCKET_LEASE_EXPIRY_ID,
    PLANNER_BUCKET_OPTION_DEADLINES_ID,
    PLANNER_BUCKET_RENT_REVIEWS_ID,
    PLANNER_BUCKET_JOB_UPDATES_ID,
  } = process.env;
  switch (triggerType) {
    case "lease_expiry":
      return PLANNER_BUCKET_LEASE_EXPIRY_ID ?? "";
    case "option_notice":
      return PLANNER_BUCKET_OPTION_DEADLINES_ID ?? "";
    case "rent_review":
      return PLANNER_BUCKET_RENT_REVIEWS_ID ?? "";
    case "job_update_due":
      return PLANNER_BUCKET_JOB_UPDATES_ID ?? "";
  }
}

async function plannerSyncTimer(
  _timer: Timer,
  context: InvocationContext,
): Promise<void> {
  context.log("plannerSyncTimer: starting");

  const { PLANNER_GROUP_ID, PLANNER_PLAN_ID, APP_BASE_URL } = process.env;

  if (!PLANNER_GROUP_ID || !PLANNER_PLAN_ID || !APP_BASE_URL) {
    context.error(
      "plannerSyncTimer: missing PLANNER_GROUP_ID, PLANNER_PLAN_ID, or APP_BASE_URL — skipping",
    );
    return;
  }

  let connection;
  try {
    const assigneeIds = await graphGetGroupMembers(PLANNER_GROUP_ID);
    if (assigneeIds.length === 0) {
      context.warn(
        "plannerSyncTimer: no group members found — tasks will have no assignees",
      );
    }
    context.log(`plannerSyncTimer: ${assigneeIds.length} assignees`);

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
          const bucketId = bucketIdForTriggerType(triggerType);

          if (existing.length === 0) {
            try {
              const taskId = await graphCreatePlannerTask({
                planId: PLANNER_PLAN_ID,
                bucketId,
                title,
                dueDate: dueDateStr,
                assigneeIds,
                description,
              });
              await executeQuery(
                connection,
                `INSERT INTO dbo.PlannerTasks
                   (EntityType, EntityId, TriggerType, LeadTimeDays, PlannerTaskId, DueDate)
                 VALUES ('tenant', @EntityId, @TriggerType, @LeadTimeDays, @TaskId, @DueDate)`,
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
                planId: PLANNER_PLAN_ID,
                bucketId,
                title,
                dueDate: dueDateStr,
                assigneeIds,
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
            }
            continue;
          }

          try {
            const task = await graphGetPlannerTask(plannerTaskId);
            if (task !== null) {
              skipped++;
            } else {
              const taskId = await graphCreatePlannerTask({
                planId: PLANNER_PLAN_ID,
                bucketId,
                title,
                dueDate: dueDateStr,
                assigneeIds,
                description,
              });
              await executeQuery(
                connection,
                `UPDATE dbo.PlannerTasks
                 SET PlannerTaskId = @TaskId, DueDate = @DueDate
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
      const bucketId = bucketIdForTriggerType("job_update_due");

      if (existing.length === 0) {
        try {
          const taskId = await graphCreatePlannerTask({
            planId: PLANNER_PLAN_ID,
            bucketId,
            title,
            dueDate: dueDateStr,
            assigneeIds,
            description,
          });
          await executeQuery(
            connection,
            `INSERT INTO dbo.PlannerTasks
               (EntityType, EntityId, TriggerType, LeadTimeDays, PlannerTaskId, DueDate)
             VALUES ('job', @EntityId, 'job_update_due', 0, @TaskId, @DueDate)`,
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
              planId: PLANNER_PLAN_ID,
              bucketId,
              title,
              dueDate: dueDateStr,
              assigneeIds,
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
            planId: PLANNER_PLAN_ID,
            bucketId,
            title,
            dueDate: dueDateStr,
            assigneeIds,
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
      const plannerTaskId = row.PlannerTaskId as string;
      try {
        const task = await graphGetPlannerTask(plannerTaskId);
        if (task) {
          await graphCompletePlannerTask(plannerTaskId, task.etag);
        }
        await executeQuery(
          connection,
          `UPDATE dbo.PlannerTasks
           SET Status = 'resolved', ResolvedAt = SYSUTCDATETIME()
           WHERE Id = @Id`,
          [{ name: "Id", type: TYPES.Int, value: row.Id as number }],
        );
        resolved++;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        context.error(
          `plannerSyncTimer: failed to resolve overdue task ${plannerTaskId}:`,
          message,
        );
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
