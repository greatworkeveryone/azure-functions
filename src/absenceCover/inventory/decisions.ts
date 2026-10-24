// Decision requests waiting on an absent person. Only a request where EVERY person
// asked is away is at risk: if one of the people named is in, they can answer it.
// Role requests (everyone in a role was asked) are left to the role. Due: the
// request's respond-by time; an emergency has none and counts as due at once.

import type { Connection } from "tedious";
import { executeQuery } from "../../db";
import { jobLabel } from "../../escalation/adapters/job";
import { toRequestRow } from "../../jobDecisions/store";
import { decisionImportance } from "../importance";
import type { CoverItem } from "../types";

const QUESTION_MAX = 80;

export async function loadDecisionItems(connection: Connection, absentIds: ReadonlySet<number>): Promise<CoverItem[]> {
  if (absentIds.size === 0) return [];
  const rows = await executeQuery(
    connection,
    `SELECT r.RequestId, r.JobId, r.Question, r.DecisionMakers, r.AssignmentMode, r.Tier, r.RespondBy, r.RoutineWeeks,
            r.AutoEscalate, r.SourceAttachmentId, r.State, r.RequestedBy, r.RequestedByUserId, r.RequestedAt,
            r.WithdrawnAt, r.WithdrawnBy, r.WithdrawnByUserId, r.WithdrawnReason, r.RowVersion,
            j.Title, b.BuildingName
       FROM dbo.JobDecisionRequests r
       INNER JOIN dbo.Jobs j ON j.JobID = r.JobId
       LEFT JOIN dbo.Buildings b ON b.BuildingID = j.BuildingID
      WHERE r.State = N'pending' AND r.AssignmentMode = N'named' AND j.IsArchived = 0 AND j.IsTest = 0`,
  );
  const items: CoverItem[] = [];
  for (const raw of rows) {
    const request = toRequestRow(raw);
    const asked = request.decisionMakers.userIds;
    if (asked.length === 0 || !asked.every((id) => absentIds.has(id))) continue;
    const rated = decisionImportance(request.tier);
    const question = request.question.length > QUESTION_MAX ? `${request.question.slice(0, QUESTION_MAX)}...` : request.question;
    const job = jobLabel({ buildingName: typeof raw.BuildingName === "string" ? raw.BuildingName : null, jobId: request.jobId, title: String(raw.Title ?? "") });
    items.push({
      capability: "respondToDecision",
      deepLink: `/jobs?jobId=${request.jobId}`,
      detail: { jobId: request.jobId, requestId: request.requestId, rowVersion: request.rowVersion },
      dueAt: request.respondBy ?? request.requestedAt,
      id: String(request.requestId),
      importance: rated.importance,
      importanceCode: rated.code,
      isTest: false,
      label: `Decision asked on ${job}: ${question}`,
      minRole: null,
      money: null,
      move: "decision_makers",
      ownerUserId: asked[0],
      personal: false,
      raisedByUserId: request.requestedByUserId,
      type: "decision_request",
    });
  }
  return items;
}
