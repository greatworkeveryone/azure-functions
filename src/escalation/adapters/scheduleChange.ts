// The schedule change adapter (WP26c, PLAN D24): describes a pending change to
// the engine for schedule.change_ratification (authority, the directors), links
// to /tenancy/changes/{requestId} (the frontend resolves it to the tenancy's
// schedule with the change open), and limits who may see these to the roles that
// may read a tenancy, the CFO included. The escalation ends with the director's
// decision (ratify, reject) or the requester's withdrawal, never by hand.

import { type Connection, TYPES } from "tedious";
import { executeQuery } from "../../db";
import { reliefOfRow } from "../../scheduleChange/dto";
import { RATIFICATION_POLICY, reliefSummary, SCHEDULE_CHANGE_SUBJECT } from "../../scheduleChange/types";
import { normaliseRole, ROLES } from "../roles";
import type { EscalationAdapter } from "./registry";

const VIEW_ROLES: ReadonlySet<string> = new Set([ROLES.accounts, ROLES.accountsManager, ROLES.admin, ROLES.cfo, ROLES.director]);

const SUMMARY_MAX = 160;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

const CHANGE_SQL = `SELECT c.RequestId, c.TenantId, c.Kind, c.Payload, c.State, c.RequestedByName,
    t.BuildingId, t.LegalName, t.TradingName, b.BuildingName
  FROM dbo.ScheduleChangeRequests c
  INNER JOIN dbo.Tenants t ON t.TenantId = c.TenantId
  LEFT JOIN dbo.Buildings b ON b.BuildingID = t.BuildingId
  WHERE c.RequestId = @RequestId`;

async function loadChange(connection: Connection, requestId: string) {
  if (!REQUEST_ID_RE.test(requestId)) return null;
  return (await executeQuery(connection, CHANGE_SQL, [{ name: "RequestId", type: TYPES.NVarChar, value: requestId }]))[0] ?? null;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

export const scheduleChangeAdapter: EscalationAdapter = {
  subjectType: SCHEDULE_CHANGE_SUBJECT,

  deepLink: (subjectId) => `/tenancy/changes/${encodeURIComponent(subjectId)}`,

  // Asked only of attention escalations; the ratification is authority. Still
  // true exactly while the change waits for a director.
  async isConditionActive(connection, ref) {
    const row = await loadChange(connection, ref.subjectId);
    return row !== null && row.State === "pending";
  },

  ledgerScope: (escalation) => {
    const tenantId = Number(escalation.context?.tenantId);
    return { tenantId: Number.isInteger(tenantId) && tenantId > 0 ? tenantId : null };
  },

  async loadSummary(connection, subjectId) {
    const row = await loadChange(connection, subjectId);
    if (!row) return null;
    const tenantId = Number(row.TenantId);
    const tenantName = text(row.TradingName) ?? text(row.LegalName) ?? `Tenancy ${tenantId}`;
    const buildingName = text(row.BuildingName);
    const relief = reliefOfRow(row);
    const what = relief ? reliefSummary(relief) : `Schedule change (${String(row.Kind).replace(/_/g, " ")})`;
    return {
      buildingId: row.BuildingId === null || row.BuildingId === undefined ? null : Number(row.BuildingId),
      context: {
        buildingName,
        from: relief?.from ?? null,
        kind: row.Kind,
        requestedByName: text(row.RequestedByName),
        requestId: subjectId,
        tenantId,
        tenantName,
        to: relief?.to ?? null,
      },
      summary: [what, tenantName, buildingName].filter((part): part is string => Boolean(part)).join(" · ").slice(0, SUMMARY_MAX),
    };
  },

  visibleTo: (viewer) => viewer.roles.some((role) => VIEW_ROLES.has(normaliseRole(role))),

  // Only the decision (or the requester's withdrawal) ends it.
  withdrawable: (escalation) => escalation.policyKey !== RATIFICATION_POLICY,
};
