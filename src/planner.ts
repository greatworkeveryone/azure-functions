import { TYPES } from "tedious";
import { closeConnection, createServiceConnection, executeQuery } from "./db";
import { getGraphToken } from "./graph";
import { PLANNER_SYNC_DISABLED_MESSAGE, plannerSyncEnabled } from "./plannerFlag";
import type { TriggerType } from "./plannerHelpers";
import { assertMayLeave, type EgressSubject } from "./test-data";

// Every Graph call below is behind PLANNER_SYNC_ENABLED (see plannerFlag.ts).
// The orchestrators (reconcilers, timer, resolveActivePlannerTasks) check it first
// so they do no work at all when it is off; these guards are the backstop that
// stops a stray caller reaching Planner. They throw rather than return, because a
// fake task id would be written into dbo.PlannerTasks.
function requirePlannerSyncEnabled(operation: string): void {
  if (!plannerSyncEnabled()) throw new Error(`${operation}: ${PLANNER_SYNC_DISABLED_MESSAGE}`);
}

export interface PlanConfig {
  planId: string;
  bucketId: string;
}

export function getPlanConfig(triggerType: TriggerType): PlanConfig {
  const e = process.env;
  switch (triggerType) {
    case "lost_key_reported":
      return {
        planId:   e.PLANNER_FACILITIES_PLAN_ID              ?? "",
        bucketId: e.PLANNER_FACILITIES_BUCKET_LOST_KEYS_ID  ?? "",
      };
    case "stalled_facilities":
    case "job_update_due":
      return {
        planId:   e.PLANNER_FACILITIES_PLAN_ID             ?? "",
        bucketId: e.PLANNER_FACILITIES_BUCKET_JOB_UPDATES_ID ?? "",
      };
    case "awaiting_accounts":
      return {
        planId:   e.PLANNER_ACCOUNTS_PLAN_ID          ?? "",
        bucketId: e.PLANNER_ACCOUNTS_BUCKET_AWAITING_ID ?? "",
      };
    case "awaiting_facilities_approval":
      // Quote sign-off sits on the Facilities plan. If the bucket env is unset,
      // bucketId is "" and reconcileTask skips gracefully (same guard the other
      // facilities triggers rely on) — it never throws.
      return {
        planId:   e.PLANNER_FACILITIES_PLAN_ID                       ?? "",
        bucketId: e.PLANNER_FACILITIES_BUCKET_AWAITING_APPROVAL_ID   ?? "",
      };
    case "director_approval":
      return {
        planId:   e.PLANNER_ACCOUNTS_PLAN_ID           ?? "",
        bucketId: e.PLANNER_ACCOUNTS_BUCKET_DIRECTOR_ID ?? "",
      };
    case "oncharge_pending":
      return {
        planId:   e.PLANNER_ACCOUNTS_PLAN_ID            ?? "",
        bucketId: e.PLANNER_ACCOUNTS_BUCKET_ONCHARGE_ID ?? "",
      };
    case "lease_expiry":
      return {
        planId:   e.PLANNER_ACCOUNTS_PLAN_ID                ?? "",
        bucketId: e.PLANNER_ACCOUNTS_BUCKET_LEASE_EXPIRY_ID ?? "",
      };
    case "option_notice":
      return {
        planId:   e.PLANNER_ACCOUNTS_PLAN_ID                    ?? "",
        bucketId: e.PLANNER_ACCOUNTS_BUCKET_OPTION_DEADLINES_ID ?? "",
      };
    case "rent_review":
      return {
        planId:   e.PLANNER_ACCOUNTS_PLAN_ID               ?? "",
        bucketId: e.PLANNER_ACCOUNTS_BUCKET_RENT_REVIEWS_ID ?? "",
      };
  }
}

export async function graphGetGroupMembers(groupId: string): Promise<string[]> {
  requirePlannerSyncEnabled("graphGetGroupMembers");
  const token = await getGraphToken();
  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/groups/${encodeURIComponent(groupId)}/members?$select=id`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`graphGetGroupMembers failed: ${resp.status} — ${text}`);
  }
  const data = (await resp.json()) as { value: Array<{ id: string }> };
  return (data.value ?? []).map((m) => m.id);
}

export interface CreatePlannerTaskParams {
  /** What the task is about; a test record never reaches Planner (D9). */
  egress: EgressSubject;
  planId: string;
  bucketId: string;
  title: string;
  dueDate: string;
  assigneeIds: string[];
  description: string;
}

export async function graphCreatePlannerTask(
  params: CreatePlannerTaskParams,
): Promise<string> {
  requirePlannerSyncEnabled("graphCreatePlannerTask");
  assertMayLeave("planner", params.egress);
  const token = await getGraphToken();
  const { planId, bucketId, title, dueDate, assigneeIds, description } = params;

  const assignments: Record<string, unknown> = {};
  for (const id of assigneeIds) {
    assignments[id] = {
      "@odata.type": "#microsoft.graph.plannerAssignment",
      orderHint: " !",
    };
  }

  const createResp = await fetch("https://graph.microsoft.com/v1.0/planner/tasks", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      planId,
      bucketId,
      title,
      dueDateTime: `${dueDate}T00:00:00Z`,
      assignments,
    }),
  });
  if (!createResp.ok) {
    const text = await createResp.text();
    throw new Error(`graphCreatePlannerTask failed: ${createResp.status} — ${text}`);
  }
  const task = (await createResp.json()) as { id: string };
  const taskId = task.id;

  const detailsResp = await fetch(
    `https://graph.microsoft.com/v1.0/planner/tasks/${encodeURIComponent(taskId)}/details`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!detailsResp.ok) {
    return taskId;
  }
  const detailsEtag = detailsResp.headers.get("ETag") ?? "";

  await fetch(
    `https://graph.microsoft.com/v1.0/planner/tasks/${encodeURIComponent(taskId)}/details`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "If-Match": detailsEtag,
      },
      body: JSON.stringify({ description }),
    },
  );

  return taskId;
}

export async function graphGetPlannerTask(
  taskId: string,
): Promise<{ etag: string } | null> {
  requirePlannerSyncEnabled("graphGetPlannerTask");
  const token = await getGraphToken();
  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/planner/tasks/${encodeURIComponent(taskId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`graphGetPlannerTask failed: ${resp.status} — ${text}`);
  }
  const etag = resp.headers.get("ETag") ?? "";
  return { etag };
}

export async function graphCompletePlannerTask(
  taskId: string,
  etag: string,
): Promise<void> {
  requirePlannerSyncEnabled("graphCompletePlannerTask");
  const token = await getGraphToken();
  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/planner/tasks/${encodeURIComponent(taskId)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "If-Match": etag,
      },
      body: JSON.stringify({ percentComplete: 100 }),
    },
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`graphCompletePlannerTask failed: ${resp.status} — ${text}`);
  }
}

export async function resolveActivePlannerTasks(
  entityType: string,
  entityId: number,
  triggerTypes: TriggerType[],
): Promise<void> {
  if (!plannerSyncEnabled()) return;
  if (triggerTypes.length === 0) return;

  let connection;
  try {
    connection = await createServiceConnection();
    const placeholders = triggerTypes.map((_, i) => `@TT${i}`).join(", ");
    const params = [
      { name: "EntityType", type: TYPES.NVarChar, value: entityType },
      { name: "EntityId", type: TYPES.Int, value: entityId },
      ...triggerTypes.map((t, i) => ({
        name: `TT${i}`,
        type: TYPES.NVarChar,
        value: t,
      })),
    ];
    const rows = await executeQuery(
      connection,
      `SELECT Id, PlannerTaskId FROM dbo.PlannerTasks
       WHERE EntityType = @EntityType AND EntityId = @EntityId
         AND Status = 'active' AND TriggerType IN (${placeholders})`,
      params,
    );

    for (const row of rows) {
      const plannerTaskId = row.PlannerTaskId as string;
      const rowId = row.Id as number;
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
          [{ name: "Id", type: TYPES.Int, value: rowId }],
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `resolveActivePlannerTasks: failed for task ${plannerTaskId}:`,
          message,
        );
      }
    }
  } finally {
    if (connection) closeConnection(connection);
  }
}
