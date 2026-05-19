import { TYPES } from "tedious";
import { closeConnection, createServiceConnection, executeQuery } from "./db";
import { getGraphToken } from "./graph";
import type { TriggerType } from "./plannerHelpers";

export async function graphGetGroupMembers(groupId: string): Promise<string[]> {
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
