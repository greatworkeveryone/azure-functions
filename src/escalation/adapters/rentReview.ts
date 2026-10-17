// The rent review adapter (WP26, PLAN §3.4, §3.7): describes a review to the
// engine, says whether its E1 / E2 condition still holds (rentReview/
// escalationRules.ts, read for today's Darwin date from the review's own date),
// links to /tenancy/reviews/{id}, and limits who may see these to the roles
// that may read a tenancy, the CFO included.

import { type Connection, TYPES } from "tedious";
import { todayInDarwin } from "../../darwinDate";
import { executeQuery } from "../../db";
import { formatDisplayDate } from "../../digest/format";
import { sqlDateToIso } from "../../nextReviewDate";
import { RENT_REVIEW_STATES, type RentReviewState } from "../../rentReviewMachine";
import { REVIEW_POLICIES, reviewConditionActive } from "../../rentReview/escalationRules";
import { normaliseRole, ROLES } from "../roles";
import type { EscalationAdapter } from "./registry";

// Who may see escalations about a review: whoever may read a tenancy (TENANCY_VIEW_ROLES
// in rentReview/http.ts, the gate on getRentReview; frontend capability viewRentReviews),
// plus the CFO, who reads tenancies through requireRole's accounts inheritance.
const REVIEW_VIEW_ROLES: ReadonlySet<string> = new Set([
  ROLES.accounts,
  ROLES.accountsManager,
  ROLES.admin,
  ROLES.cfo,
  ROLES.director,
]);

const SUMMARY_PARTS_MAX = 160;
const REVIEW_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

const METHOD_LABEL: Record<string, string> = { cpi: "CPI review", fixed: "Fixed review", market: "Market review", other: "Rent review" };

const REVIEW_SQL = `SELECT r.ReviewId, r.TenantId, r.ScheduledFor, r.State, r.Method,
    t.BuildingId, t.LegalName, t.TradingName, t.Status AS TenantStatus, t.ArchivedAt AS TenantArchivedAt, b.BuildingName
  FROM dbo.RentReviews r
  INNER JOIN dbo.Tenants t ON t.TenantId = r.TenantId
  LEFT JOIN dbo.Buildings b ON b.BuildingID = t.BuildingId
  WHERE r.ReviewId = @ReviewId AND r.State IS NOT NULL`;

async function loadReview(connection: Connection, reviewId: string) {
  if (!REVIEW_ID_RE.test(reviewId)) return null;
  const rows = await executeQuery(connection, REVIEW_SQL, [{ name: "ReviewId", type: TYPES.NVarChar, value: reviewId }]);
  const row = rows[0];
  if (!row || !RENT_REVIEW_STATES.includes(row.State as RentReviewState)) return null;
  return row;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

export const rentReviewAdapter: EscalationAdapter = {
  subjectType: "rent_review",

  deepLink: (subjectId) => `/tenancy/reviews/${encodeURIComponent(subjectId)}`,

  async isConditionActive(connection, ref, now) {
    const row = await loadReview(connection, ref.subjectId);
    if (!row) return false;
    return reviewConditionActive(
      ref.policyKey,
      {
        scheduledFor: sqlDateToIso(row.ScheduledFor) ?? "",
        state: row.State as RentReviewState,
        tenancyClosed: row.TenantStatus === "vacated" || (row.TenantArchivedAt !== null && row.TenantArchivedAt !== undefined),
      },
      todayInDarwin(now),
    );
  },

  ledgerScope: (escalation) => {
    const tenantId = Number(escalation.context?.tenantId);
    return { tenantId: Number.isInteger(tenantId) && tenantId > 0 ? tenantId : null };
  },

  async loadSummary(connection, subjectId) {
    const row = await loadReview(connection, subjectId);
    if (!row) return null;
    const tenantId = Number(row.TenantId);
    const tenantName = text(row.TradingName) ?? text(row.LegalName) ?? `Tenancy ${tenantId}`;
    const buildingName = text(row.BuildingName);
    const scheduledFor = sqlDateToIso(row.ScheduledFor) ?? "";
    const method = typeof row.Method === "string" ? row.Method : null;
    const what = `${METHOD_LABEL[method ?? ""] ?? "Rent review"} ${scheduledFor ? formatDisplayDate(scheduledFor) : ""}`.trim();
    return {
      buildingId: row.BuildingId === null || row.BuildingId === undefined ? null : Number(row.BuildingId),
      context: { buildingName, method, reviewId: subjectId, scheduledFor, state: row.State, tenantId, tenantName },
      summary: [what, tenantName, buildingName].filter((part): part is string => Boolean(part)).join(" · ").slice(0, SUMMARY_PARTS_MAX),
    };
  },

  visibleTo: (viewer) => viewer.roles.some((role) => REVIEW_VIEW_ROLES.has(normaliseRole(role))),

  // E3 ends with the review's own decision (approve, return, waive, cancel):
  // withdrawing it by hand would leave the review waiting with nobody asked,
  // and C7 reading a lower rung (L3). Neither its raiser (the preparer) nor admin may.
  withdrawable: (escalation) => escalation.policyKey !== REVIEW_POLICIES.approval,
};
