// Durable acknowledgements for decisions 7 and 23; explicitly resolved in For you.
import { TYPES } from "tedious";
import { executeQuery } from "../../db";
import type { EscalationAdapter } from "./registry";
const parse = (value: string) => /^(quote|invoice|tenancy):(\d+)@(\d+)$/.exec(value);
export const reviewNoticeAdapter: EscalationAdapter = {
  subjectType: "review_notice",
  async loadSummary(connection, subjectId) {
    const ref = parse(subjectId);
    if (!ref) return null;
    const tenancy = ref[1] === "tenancy";
    const rows = await executeQuery(connection, tenancy
      ? "SELECT BuildingId FROM dbo.Tenants WHERE TenantId=@Id"
      : "SELECT BuildingID AS BuildingId FROM dbo.Jobs WHERE JobID=@Id", [
      { name: "Id", type: TYPES.Int, value: Number(tenancy ? ref[2] : ref[3]) },
    ]);
    return rows[0] ? { buildingId: rows[0].BuildingId == null ? null : Number(rows[0].BuildingId), summary: "Decision recorded for review", context: {} } : null;
  },
  async isConditionActive() { return true; },
  deepLink(subjectId) {
    const ref = parse(subjectId);
    return !ref ? "/escalations" : ref[1] === "tenancy" ? `/tenancy/${ref[2]}` : `/jobs?jobId=${ref[3]}`;
  },
  visibleTo(viewer) { return viewer.roles.some(role => ["director", "cfo", "admin", "accounts_manager", "facilities_manager"].includes(role)); },
  ledgerScope(row) {
    const ref = parse(row.subjectId);
    return !ref ? {} : ref[1] === "tenancy" ? { tenantId: Number(ref[2]) } : { jobId: Number(ref[3]) };
  },
};
