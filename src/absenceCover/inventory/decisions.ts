// Decision requests waiting on an absent person. Only a request where EVERY person
// asked is away is at risk: if one of the people named is in, they can answer it.
// Role requests (everyone in a role was asked) are left to the role. Due: the
// request's respond-by time; an emergency has none and counts as due at once.
// A question was put to those people for their standing: its cover must hold the
// most senior role among them or sit above it, so a director's question is never
// answered by someone the asker would not have named (minRole).

import type { Connection } from "tedious";
import { executeQuery } from "../../db";
import { jobLabel } from "../../escalation/adapters/job";
import { isAbove } from "../../escalation/roles";
import { toRequestRow } from "../../jobDecisions/store";
import { decisionImportance } from "../importance";
import type { CoverItem } from "../types";

const QUESTION_MAX = 80;

/** The most senior of the roles held by the people asked; null when none is known. */
export function seniorRole(roles: readonly string[]): string | null {
  return roles.reduce<string | null>((top, role) => (top === null || isAbove(role, top) ? role : top), null);
}

export async function loadDecisionItems(connection: Connection, absentIds: ReadonlySet<number>, roleOf: ReadonlyMap<number, string>): Promise<CoverItem[]> {
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
      minRole: seniorRole(asked.flatMap((id) => (roleOf.get(id) ? [roleOf.get(id) as string] : []))),
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
