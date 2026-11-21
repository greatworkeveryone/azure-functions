// Tenancy approvals: rent reviews awaiting approval, schedule changes awaiting a director, option notices awaiting
// approval, and schedules not signed off with a review date near. Each is read from its own table (not from the
// escalation rows, which a policy switch can leave empty), and each checks the capability its action uses; the
// person who prepared a review or recorded a notice does not approve it, and for them it is a thing they wait on.

import { executeQuery, type SqlRow } from "../../db";
import { UNSIGNED_WINDOW_DAYS } from "../../escalation/adapters/tenancyFacts";
import type { Candidate, SourceAdapter } from "../types";
import { holds, iso, text } from "../util";

export interface TenancyFacts {
  changes: SqlRow[];
  events: SqlRow[];
  reviews: SqlRow[];
  unsigned: SqlRow[];
}

const LIVE = `t.ArchivedAt IS NULL AND t.Status <> N'vacated' AND ISNULL(t.IsTest, 0) = 0`;
const name = (row: SqlRow): string => text(row.TradingName) ?? text(row.LegalName) ?? `Tenancy ${row.TenantId}`;

export const tenancySource: SourceAdapter<TenancyFacts> = {
  name: "tenancy",
  async load(connection) {
    return {
      changes: await executeQuery(connection, `SELECT TOP (200) c.RequestId, c.TenantId, c.Kind, c.RequestedById, c.RequestedByName, c.RequestedAt, t.LegalName, t.TradingName, b.BuildingName FROM dbo.ScheduleChangeRequests c JOIN dbo.Tenants t ON t.TenantId = c.TenantId LEFT JOIN dbo.Buildings b ON b.BuildingID = t.BuildingId WHERE c.State = N'pending' AND ${LIVE}`),
      events: await executeQuery(connection, `SELECT TOP (200) e.LeaseEventId, e.TenantId, e.RecordedById, e.RecordedByName, e.RecordedAt, t.LegalName, t.TradingName, b.BuildingName FROM dbo.LeaseEvents e JOIN dbo.Tenants t ON t.TenantId = e.TenantId LEFT JOIN dbo.Buildings b ON b.BuildingID = t.BuildingId WHERE e.State = N'awaiting_approval' AND e.ArchivedAt IS NULL AND ${LIVE}`),
      reviews: await executeQuery(connection, `SELECT TOP (200) r.ReviewId, r.TenantId, r.PreparedById, r.PreparedByName, r.SubmittedAt, t.LegalName, t.TradingName, b.BuildingName FROM dbo.RentReviews r JOIN dbo.Tenants t ON t.TenantId = r.TenantId LEFT JOIN dbo.Buildings b ON b.BuildingID = t.BuildingId WHERE r.State = N'awaiting_approval' AND ${LIVE}`),
      unsigned: await executeQuery(connection, `SELECT TOP (200) t.TenantId, t.LegalName, t.TradingName, t.NextReviewDate, b.BuildingName FROM dbo.Tenants t LEFT JOIN dbo.Buildings b ON b.BuildingID = t.BuildingId WHERE ${LIVE} AND t.ScheduleSignedOffAt IS NULL AND t.NextReviewDate IS NOT NULL AND t.NextReviewDate <= DATEADD(DAY, ${UNSIGNED_WINDOW_DAYS}, CAST(SYSUTCDATETIME() AS DATE))`),
    };
  },
  derive(facts, viewer) {
    const out: Candidate[] = [];
    const entry = (row: SqlRow, input: { id: string; kind: string; link: string; madeBy: unknown; madeByName: unknown; capability: string; subject: string; verb: string; wait: string; at: unknown }): void => {
      const own = viewer.userId !== null && input.madeBy === viewer.userId;
      const canAct = !own && holds(viewer, input.capability);
      if (!canAct && !own) return;
      out.push({
        canAct,
        chasedNext: null,
        dueAt: null,
        from: text(input.madeByName),
        group: canAct ? "decide" : "waiting",
        id: input.id,
        key: input.id,
        kind: input.kind,
        link: input.link,
        place: text(row.BuildingName),
        subject: input.subject,
        verb: canAct ? input.verb : input.wait,
        waitingSince: iso(input.at),
        with: canAct ? null : "an approver",
      });
    };
    for (const row of facts.reviews) {
      entry(row, { at: row.SubmittedAt, capability: "approveRentReview", id: `rent_review:${row.ReviewId}`, kind: "rent_review", link: `/tenancy/reviews/${encodeURIComponent(String(row.ReviewId))}`, madeBy: row.PreparedById, madeByName: row.PreparedByName, subject: `Rent review · ${name(row)}`, verb: "Approve rent review", wait: "Waiting for approval" });
    }
    for (const row of facts.changes) {
      entry(row, { at: row.RequestedAt, capability: "ratifyScheduleChange", id: `schedule_change:${row.RequestId}`, kind: "schedule_change", link: `/tenancy/changes/${encodeURIComponent(String(row.RequestId))}`, madeBy: row.RequestedById, madeByName: row.RequestedByName, subject: `Schedule change (${String(row.Kind).replace(/_/g, " ")}) · ${name(row)}`, verb: "Ratify change", wait: "Waiting for a director" });
    }
    for (const row of facts.events) {
      entry(row, { at: row.RecordedAt, capability: "approveOptionExercise", id: `lease_option:${row.LeaseEventId}`, kind: "lease_option", link: `/tenancy/${row.TenantId}?tab=lease`, madeBy: row.RecordedById, madeByName: row.RecordedByName, subject: `Option notice · ${name(row)}`, verb: "Approve option", wait: "Waiting for approval" });
    }
    if (holds(viewer, "signOffTenancySchedule")) {
      for (const row of facts.unsigned) {
        const due = row.NextReviewDate instanceof Date ? row.NextReviewDate : null;
        out.push({ canAct: true, chasedNext: null, dueAt: iso(due), from: null, group: "do", id: `tenancy_signoff:${row.TenantId}`, key: `tenancy_signoff:${row.TenantId}`, kind: "tenancy_signoff", link: `/tenancy/${row.TenantId}`, place: text(row.BuildingName), subject: `Schedule to sign off · ${name(row)}`, verb: "Sign off schedule", waitingSince: due ? new Date(due.getTime() - UNSIGNED_WINDOW_DAYS * 86_400_000).toISOString() : null });
      }
    }
    return out;
  },
};
