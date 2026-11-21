// Decision requests on a job (a question put to named people, or to a role). The people asked may answer it
// (respondToDecision, the same gate the answer route uses); the person who asked is waiting on them.

import { executeQuery } from "../../db";
import { toRequestRow, type DecisionRequestRow } from "../../jobDecisions/store";
import type { Candidate, SourceAdapter } from "../types";
import { holds, iso, jobTitle, joinNames, text } from "../util";

export interface DecisionFacts {
  places: Map<number, { building: string | null; title: string | null }>;
  requests: DecisionRequestRow[];
}

const SQL = `SELECT r.RequestId, r.JobId, r.Question, r.DecisionMakers, r.AssignmentMode, r.Tier, r.RespondBy, r.RoutineWeeks, r.AutoEscalate,
       r.SourceAttachmentId, r.State, r.RequestedBy, r.RequestedByUserId, r.RequestedAt, r.WithdrawnAt, r.WithdrawnBy, r.WithdrawnByUserId,
       r.WithdrawnReason, r.RowVersion, j.Title, b.BuildingName
  FROM dbo.JobDecisionRequests r
  JOIN dbo.Jobs j ON j.JobID = r.JobId
  LEFT JOIN dbo.Buildings b ON b.BuildingID = j.BuildingID
 WHERE r.State = N'pending' AND j.IsArchived = 0 AND j.IsTest = 0`;

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max)}...` : value);

export const decisionsSource: SourceAdapter<DecisionFacts> = {
  name: "decisions",
  async load(connection) {
    const rows = await executeQuery(connection, SQL);
    const places = new Map<number, { building: string | null; title: string | null }>();
    for (const row of rows) places.set(Number(row.JobId), { building: text(row.BuildingName), title: text(row.Title) });
    return { places, requests: rows.map(toRequestRow) };
  },
  derive(facts, viewer, ctx) {
    const out: Candidate[] = [];
    for (const request of facts.requests) {
      const asked = request.decisionMakers.userIds;
      const named = viewer.userId !== null && asked.includes(viewer.userId);
      const byRole = request.assignmentMode === "role" && request.decisionMakers.role !== null && viewer.roles.includes(request.decisionMakers.role.toLowerCase());
      const place = facts.places.get(request.jobId);
      const base = {
        chasedNext: null,
        dueAt: iso(request.respondBy),
        id: `decision:${request.requestId}`,
        key: `decision:${request.requestId}`,
        kind: "decision",
        link: `/jobs?jobId=${request.jobId}&decision=${request.requestId}`,
        place: place?.building ?? null,
        waitingSince: iso(request.requestedAt),
      };
      const subject = `${clip(request.question, 80)} · ${jobTitle({ JobID: request.jobId, Title: place?.title })}`;
      if ((named || byRole) && holds(viewer, "respondToDecision") && request.requestedByUserId !== viewer.userId) {
        out.push({ ...base, canAct: true, from: request.requestedBy, group: "decide", subject, verb: "Answer the question" });
      } else if (viewer.userId !== null && request.requestedByUserId === viewer.userId) {
        const names = asked.map((id) => ctx.directory.find((user) => user.userId === id)?.name).filter((name): name is string => Boolean(name));
        out.push({ ...base, canAct: false, from: null, group: "waiting", subject, verb: "Waiting for an answer", with: names.length > 0 ? joinNames(names) : request.decisionMakers.role ? `a ${request.decisionMakers.role.replace(/_/g, " ")}` : null });
      }
    }
    return out;
  },
};
