// The work_request adapter (TR1, PLAN §15): an incoming tenant request nobody has acknowledged inside the response
// target Facilities set. Policy request.unacknowledged (migration 182). The condition holds while the request is
// still received: acknowledging it, closing it, raising a job from it or completing it ends the escalation.

import { TYPES } from "tedious";
import { ACTION_ROLES } from "../../action-roles";
import { rolesPassGate } from "../../auth";
import { executeQuery } from "../../db";
import { storedState } from "../../intake/state";
import { parseWorkRequestId } from "../../workRequestsNative";
import { normaliseRole } from "../roles";
import { REQUEST_SUBJECT_TYPE } from "../../intake/overdue";
import type { EscalationAdapter } from "./registry";

const SQL = `SELECT wr.WorkRequestID, wr.BuildingID, wr.BuildingName, wr.IntakeState, wr.ActualCompletionDate,
         COALESCE(o.TenantName, wr.TenantName) AS TenantName, COALESCE(o.[Type], wr.[Type]) AS RequestType,
         COALESCE(o.Priority, wr.Priority) AS Priority,
         CASE WHEN EXISTS (SELECT 1 FROM dbo.Jobs j WHERE j.WorkRequestID = wr.WorkRequestID) THEN 1 ELSE 0 END AS HasJob
    FROM dbo.WorkRequests wr
    LEFT JOIN dbo.WorkRequestOverrides o ON o.WorkRequestID = wr.WorkRequestID
   WHERE wr.WorkRequestID = @Id`;

const requestId = (subjectId: string): number | null => parseWorkRequestId(subjectId);

async function load(connection: Parameters<EscalationAdapter["loadSummary"]>[0], id: number) {
  return (await executeQuery(connection, SQL, [{ name: "Id", type: TYPES.Int, value: id }]))[0] ?? null;
}

export const workRequestAdapter: EscalationAdapter = {
  subjectType: REQUEST_SUBJECT_TYPE,

  deepLink: (subjectId) => `/incoming?requestId=${encodeURIComponent(subjectId)}`,

  async isConditionActive(connection, ref) {
    const id = requestId(ref.subjectId);
    if (id === null) return false;
    const row = await load(connection, id);
    if (row === null) return false;
    return storedState(row.IntakeState) === "received" && Number(row.HasJob) === 0 && !row.ActualCompletionDate;
  },

  async loadSummary(connection, subjectId) {
    const id = requestId(subjectId);
    if (id === null) return null;
    const row = await load(connection, id);
    if (row === null) return null;
    const parts = [`Request #${id}`, String(row.RequestType ?? "").trim(), String(row.BuildingName ?? "").trim(), String(row.TenantName ?? "").trim()].filter(Boolean);
    return {
      buildingId: row.BuildingID === null || row.BuildingID === undefined ? null : Number(row.BuildingID),
      context: { buildingName: row.BuildingName ?? null, priority: row.Priority ?? null, tenantName: row.TenantName ?? null, workRequestId: id },
      summary: parts.join(" · ").slice(0, 160),
    };
  },

  // Whoever may see a request's intake: the same gate as getRequestIntake, so the two cannot drift.
  visibleTo: (viewer) => rolesPassGate(viewer.roles.map(normaliseRole), ACTION_ROLES.viewRequestIntake.gate),
};
