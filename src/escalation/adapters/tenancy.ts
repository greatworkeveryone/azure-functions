// The tenancy adapter (WP25): lets a person escalate a tenancy by hand with the
// any.manual policy (PLAN §3.7), from the tenancy page. It describes the tenancy
// to the engine, says when the problem has cleared (the tenancy was vacated or
// archived), links to /tenancy/{tenantId}, and limits who may see and raise these to the
// roles that may read a tenancy. The review adapter (WP26) is separate.

import { type Connection, TYPES } from "tedious";
import { executeQuery } from "../../db";
import { normaliseRole, ROLES } from "../roles";
import type { EscalationAdapter } from "./registry";

// Who may see escalations about a tenancy: whoever may read one
// (getRegisterTenant in functions/tenancy.ts, frontend capability viewTenancy).
// The CFO reads tenancies through requireRole's accounts inheritance, so it is
// listed here.
const TENANCY_VIEW_ROLES: ReadonlySet<string> = new Set([
  ROLES.accounts,
  ROLES.accountsManager,
  ROLES.admin,
  ROLES.cfo,
  ROLES.director,
]);

const SUMMARY_PARTS_MAX = 160;

const TENANCY_SQL = `SELECT t.TenantId, t.BuildingId, t.LegalName, t.TradingName, t.Status, t.ArchivedAt, b.BuildingName
  FROM dbo.Tenants t
  LEFT JOIN dbo.Buildings b ON b.BuildingID = t.BuildingId
  WHERE t.TenantId = @TenantId`;

function tenantId(subjectId: string): number | null {
  const id = /^\d{1,10}$/.test(subjectId) ? Number(subjectId) : Number.NaN;
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function loadTenancy(connection: Connection, id: number) {
  const rows = await executeQuery(connection, TENANCY_SQL, [{ name: "TenantId", type: TYPES.Int, value: id }]);
  return rows[0] ?? null;
}

export const tenancyAdapter: EscalationAdapter = {
  subjectType: "tenancy",

  deepLink: (subjectId) => `/tenancy/${encodeURIComponent(subjectId)}`,

  // A manual escalation lasts while the tenancy does: once it is vacated or
  // archived (D4) there is nothing left to push, so a new one is refused and an
  // open one clears. Restoring an archived tenancy makes it escalatable again.
  async isConditionActive(connection, ref) {
    const id = tenantId(ref.subjectId);
    if (id === null) return false;
    const row = await loadTenancy(connection, id);
    return row !== null && row.Status !== "vacated" && (row.ArchivedAt === null || row.ArchivedAt === undefined);
  },

  ledgerScope: (escalation) => ({ tenantId: tenantId(escalation.subjectId) }),

  async loadSummary(connection, subjectId) {
    const id = tenantId(subjectId);
    if (id === null) return null;
    const row = await loadTenancy(connection, id);
    if (!row) return null;
    const name = String(row.TradingName ?? "").trim() || String(row.LegalName ?? "").trim() || `Tenancy ${id}`;
    const buildingName = typeof row.BuildingName === "string" && row.BuildingName.trim() !== "" ? row.BuildingName.trim() : null;
    return {
      buildingId: row.BuildingId === null || row.BuildingId === undefined ? null : Number(row.BuildingId),
      context: { buildingName, status: row.Status, tenantId: id, tenantName: name },
      summary: ["Tenancy", name, buildingName].filter((part): part is string => Boolean(part)).join(" · ").slice(0, SUMMARY_PARTS_MAX),
    };
  },

  visibleTo: (viewer) => viewer.roles.some((role) => TENANCY_VIEW_ROLES.has(normaliseRole(role))),
};
