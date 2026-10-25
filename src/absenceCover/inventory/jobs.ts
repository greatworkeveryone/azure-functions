// Open jobs assigned to an absent person. Due date: when the job would go stale by
// the priority thresholds the escalation sweep uses (ESCALATION_THRESHOLD_DAYS_*),
// counted from the later of acknowledgement and the last status change.

import type { Connection } from "tedious";
import { executeQuery } from "../../db";
import { jobLabel } from "../../escalation/adapters/job";
import { stallClockStart, stallThresholdDays } from "../../escalation/adapters/jobRules";
import { jobImportance } from "../importance";
import type { CoverItem } from "../types";
import { intList } from "./sqlList";

const DAY_MS = 86_400_000;

export async function loadJobItems(connection: Connection, userIds: readonly number[]): Promise<CoverItem[]> {
  if (userIds.length === 0) return [];
  const { params, placeholders } = intList("U", userIds);
  const rows = await executeQuery(
    connection,
    `SELECT j.JobID, j.Title, j.Priority, j.AssignedTo, j.AssignedToUserID, j.CreatedAt, j.StatusSince, j.AcknowledgedAt,
            b.BuildingName
       FROM dbo.Jobs j
       LEFT JOIN dbo.Buildings b ON b.BuildingID = j.BuildingID
      WHERE j.IsArchived = 0 AND j.IsTest = 0 AND j.Status <> N'Done' AND j.AssignedToUserID IN (${placeholders})`,
    params,
  );
  return rows.map((row): CoverItem => {
    const priority = typeof row.Priority === "string" ? row.Priority : null;
    const start = stallClockStart({
      acknowledgedAt: row.AcknowledgedAt instanceof Date ? row.AcknowledgedAt : null,
      createdAt: row.CreatedAt as Date,
      statusSince: row.StatusSince instanceof Date ? row.StatusSince : null,
    } as Parameters<typeof stallClockStart>[0]);
    const rated = jobImportance(priority);
    const jobId = Number(row.JobID);
    return {
      capability: "editJobs",
      deepLink: `/jobs?jobId=${jobId}`,
      detail: { assignedTo: typeof row.AssignedTo === "string" ? row.AssignedTo : null },
      dueAt: new Date(start.getTime() + stallThresholdDays({ priority } as Parameters<typeof stallThresholdDays>[0]) * DAY_MS),
      id: String(jobId),
      importance: rated.importance,
      importanceCode: rated.code,
      isTest: false,
      label: jobLabel({ buildingName: typeof row.BuildingName === "string" ? row.BuildingName : null, jobId, title: String(row.Title ?? "") }),
      minRole: null,
      money: null,
      move: "job_assignee",
      ownerUserId: Number(row.AssignedToUserID),
      personal: false,
      raisedByUserId: null,
      type: "job",
    };
  });
}
