// The work_request adapter (TR1, PLAN §15): an incoming tenant request nobody has acknowledged inside the response
// target Facilities set. Policy request.unacknowledged (migration 182). The condition holds while the request is
// still received: acknowledging it, closing it, raising a job from it or completing it ends the escalation.

import { TYPES } from "tedious";
import { executeQuery } from "../../db";
import { storedState } from "../../intake/state";
import { normaliseRole, ROLES } from "../roles";
import type { EscalationAdapter } from "./registry";

// Who may see escalations about a request: whoever may read work requests (getWorkRequests).
const VIEW_ROLES: ReadonlySet<string> = new Set([ROLES.accounts, ROLES.accountsManager, ROLES.admin, ROLES.cfo, ROLES.director, ROLES.facilities, ROLES.facilitiesManager]);

const SQL = `SELECT wr.WorkRequestID, wr.BuildingID, wr.BuildingName, wr.IntakeState, wr.ActualCompletionDate,
         COALESCE(o.TenantName, wr.TenantName) AS TenantName, COALESCE(o.[Type], wr.[Type]) AS RequestType,
         COALESCE(o.Priority, wr.Priority) AS Priority,
         CASE WHEN EXISTS (SELECT 1 FROM dbo.Jobs j WHERE j.WorkRequestID = wr.WorkRequestID) THEN 1 ELSE 0 END AS HasJob
    FROM dbo.WorkRequests wr
    LEFT JOIN dbo.WorkRequestOverrides o ON o.WorkRequestID = wr.WorkRequestID
   WHERE wr.WorkRequestID = @Id`;

const requestId = (subjectId: string): number | null => (/^\d{1,10}$/.test(subjectId) && Number(subjectId) > 0 ? Number(subjectId) : null);

async function load(connection: Parameters<EscalationAdapter["loadSummary"]>[0], id: number) {
  return (await executeQuery(connection, SQL, [{ name: "Id", type: TYPES.Int, value: id }]))[0] ?? null;
}

export const workRequestAdapter: EscalationAdapter = {
  subjectType: "work_request",

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

  visibleTo: (viewer) => viewer.roles.some((role) => VIEW_ROLES.has(normaliseRole(role))),
};
