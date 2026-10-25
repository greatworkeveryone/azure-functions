// The lease event adapter (WP32, WP33; PLAN §3.5, §3.6, §3.7): describes an
// option exercise or renewal event to the engine, says whether an attention
// escalation's condition still holds (an open window still without a notice
// inside the warning days; a lapse not since answered by a late notice), links
// to the tenancy's Lease events section, and limits who may see these to the
// roles that may read a tenancy. The renewal referral is an authority escalation
// that ends only with the directors' outcome, so nobody withdraws it by hand.

import { type Connection, TYPES } from "tedious";
import { daysBetweenIso, todayInDarwin } from "../../darwinDate";
import { executeQuery } from "../../db";
import { LEASE_EVENT_STATES, type LeaseEventState } from "../../leaseEventMachine";
import { LEASE_POLICIES, OPTION_DEADLINE_WARNING_DAYS } from "../../leaseEvents/policies";
import { sqlDateToIso } from "../../nextReviewDate";
import { normaliseRole, ROLES } from "../roles";
import type { EscalationAdapter } from "./registry";

const VIEW_ROLES: ReadonlySet<string> = new Set([ROLES.accounts, ROLES.accountsManager, ROLES.admin, ROLES.cfo, ROLES.director]);

const SUMMARY_PARTS_MAX = 160;
const EVENT_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

const EVENT_SQL = `SELECT e.LeaseEventId, e.TenantId, e.Type, e.State, e.DeadlineOn, e.LeaseExpiry,
    t.BuildingId, t.LegalName, t.TradingName, t.Status AS TenantStatus, t.ArchivedAt AS TenantArchivedAt, b.BuildingName
  FROM dbo.LeaseEvents e
  INNER JOIN dbo.Tenants t ON t.TenantId = e.TenantId
  LEFT JOIN dbo.Buildings b ON b.BuildingID = t.BuildingId
  WHERE e.LeaseEventId = @LeaseEventId`;

async function loadEvent(connection: Connection, id: string) {
  if (!EVENT_ID_RE.test(id)) return null;
  const rows = await executeQuery(connection, EVENT_SQL, [{ name: "LeaseEventId", type: TYPES.NVarChar, value: id }]);
  const row = rows[0];
  if (!row || !LEASE_EVENT_STATES.includes(row.State as LeaseEventState)) return null;
  return row;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

/** Whether a lease event escalation's problem still exists on `today` (Darwin). Pure. */
export function leaseConditionActive(
  policyKey: string,
  event: { deadlineOn: string | null; state: LeaseEventState; tenancyClosed: boolean },
  today: string,
): boolean {
  if (event.tenancyClosed) return false;
  if (policyKey === LEASE_POLICIES.optionDeadline) {
    return (
      event.state === "window_open" &&
      event.deadlineOn !== null &&
      event.deadlineOn >= today &&
      daysBetweenIso(today, event.deadlineOn) <= OPTION_DEADLINE_WARNING_DAYS
    );
  }
  if (policyKey === LEASE_POLICIES.optionLapsed) return event.state === "lapsed";
  if (policyKey === LEASE_POLICIES.renewal) return event.state === "referred";
  // any.manual and the like last while the event is undecided.
  return ["window_not_open", "window_open", "notice_received", "awaiting_approval", "referred"].includes(event.state);
}

export const leaseEventAdapter: EscalationAdapter = {
  subjectType: "lease_event",

  deepLink: (subjectId, row) => {
    const tenantId = Number(row?.context?.tenantId);
    return Number.isInteger(tenantId) && tenantId > 0
      ? `/tenancy/${tenantId}#lease-events`
      : `/tenancy?leaseEvent=${encodeURIComponent(subjectId)}`;
  },

  async isConditionActive(connection, ref, now) {
    const row = await loadEvent(connection, ref.subjectId);
    if (!row) return false;
    return leaseConditionActive(
      ref.policyKey,
      {
        deadlineOn: sqlDateToIso(row.DeadlineOn),
        state: row.State as LeaseEventState,
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
    const row = await loadEvent(connection, subjectId);
    if (!row) return null;
    const tenantId = Number(row.TenantId);
    const tenantName = text(row.TradingName) ?? text(row.LegalName) ?? `Tenancy ${tenantId}`;
    const buildingName = text(row.BuildingName);
    const what = row.Type === "renewal" ? "Lease renewal" : "Lease option";
    return {
      buildingId: row.BuildingId === null || row.BuildingId === undefined ? null : Number(row.BuildingId),
      context: {
        buildingName,
        deadlineOn: sqlDateToIso(row.DeadlineOn),
        leaseEventId: subjectId,
        leaseExpiry: sqlDateToIso(row.LeaseExpiry),
        state: row.State,
        tenantId,
        tenantName,
        type: row.Type,
      },
      summary: [what, tenantName, buildingName].filter((part): part is string => Boolean(part)).join(" · ").slice(0, SUMMARY_PARTS_MAX),
    };
  },

  visibleTo: (viewer) => viewer.roles.some((role) => VIEW_ROLES.has(normaliseRole(role))),

  // The renewal referral ends with the directors' outcome, never by hand.
  withdrawable: (escalation) => escalation.policyKey !== LEASE_POLICIES.renewal,
};
