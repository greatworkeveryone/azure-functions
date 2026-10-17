// A director overriding a rent review's rule check, with a reason (Connor,
// 17 Oct, A2). Ledgered as rent_review.director_override, an exception that
// names the check and its facts; the endpoints that take one are behind the
// money-action gate (S11). In scope now:
//
//   C3 not_signed_off   apply although the tenancy's schedule isn't signed off;
//                       the facts are the sign-off status and its last event
//   C5 out_of_band      apply in one step although the % is outside the sanity
//                       band (no second approver for that reason alone)
//
// Not in scope: C9 on a lease's own ratchet. The schedule engine holds every
// review row of a ratchet lease at no decrease, so a director's lower rent can't
// be written until the engine carries a per-row exemption in both repos (WP26c);
// it stays refused for everyone.

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery, type SqlRow } from "../db";
import * as ledger from "../ledger";
import type { LedgerActor } from "../ledger";
import type { RentReviewCalc, StoredOverride } from "../rentReviewCalc";
import { isoTimestamp } from "../tenancyScheduleWrite";
import { readReason, RentReviewError } from "./http";

export type OverridableCheck = StoredOverride["check"];

const CHECKS: Record<OverridableCheck, { check: string; outcome: string; rule: string }> = {
  not_signed_off: { check: "C3", outcome: "applied although the schedule isn't signed off", rule: "C3_schedule_sign_off" },
  out_of_band: {
    check: "C5",
    outcome: "applied without a second approver although the change is outside the sanity band",
    rule: "C5_sanity_band",
  },
};

export interface DirectorOverride {
  checks: ReadonlySet<OverridableCheck>;
  reason: string;
}

/** body.directorOverride: { checks: [...], reason }, only the checks `allowed` here. */
export function readDirectorOverride(raw: unknown, allowed: readonly OverridableCheck[]): DirectorOverride | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new RentReviewError("bad_request", "directorOverride must be { checks, reason }");
  }
  const { checks, reason } = raw as Record<string, unknown>;
  const known = (value: unknown): value is OverridableCheck => typeof value === "string" && (allowed as readonly string[]).includes(value);
  if (!Array.isArray(checks) || checks.length === 0 || !checks.every(known)) {
    throw new RentReviewError("bad_request", `directorOverride.checks must list one or more of: ${allowed.join(", ")}`);
  }
  return { checks: new Set(checks), reason: readReason(reason, "Say why you are overriding the check (a reason is required)") };
}

const LAST_SIGN_OFF_EVENT_SQL = `SELECT TOP 1 Action, OccurredAt, ActorName, Reason
  FROM dbo.DecisionLedger
  WHERE SubjectType = N'tenancy' AND SubjectId = @TenantId
    AND Action IN (N'schedule.sign_off', N'schedule.sign_off_cleared', N'schedule.sign_off_revoke')
  ORDER BY LedgerId DESC`;

/** C3's facts: the schedule isn't signed off, at this version, and what last happened to its sign-off. */
export async function signOffFacts(connection: Connection, tenancy: SqlRow): Promise<Record<string, unknown>> {
  const rows = await executeQuery(connection, LAST_SIGN_OFF_EVENT_SQL, [
    { name: "TenantId", type: TYPES.NVarChar, value: String(tenancy.TenantId) },
  ]);
  const last = rows[0];
  return {
    lastSignOffEvent: last
      ? { action: String(last.Action), at: isoTimestamp(last.OccurredAt), by: last.ActorName ?? null, reason: last.Reason ?? null }
      : null,
    scheduleSignedOff: false,
    scheduleVersion: Number(tenancy.ScheduleVersion ?? 0),
  };
}

export interface OverrideRecord {
  actor: LedgerActor;
  buildingId: number;
  check: OverridableCheck;
  correlationId: string;
  facts: Record<string, unknown>;
  reason: string;
  reviewId: string;
  tenantId: number;
}

/** One check overridden, in the decision's own transaction. */
export async function recordDirectorOverride(connection: Connection, input: OverrideRecord): Promise<void> {
  const what = CHECKS[input.check];
  await ledger.record(connection, {
    action: "rent_review.director_override",
    actor: input.actor,
    after: { check: what.check, code: input.check, outcome: what.outcome },
    buildingId: input.buildingId,
    computed: input.facts,
    correlationId: input.correlationId,
    reason: input.reason,
    ruleApplied: what.rule,
    subject: { id: input.reviewId, type: "rent_review" },
    tenantId: input.tenantId,
  });
}

/** A C3 override made at SUBMIT rides in the calc (calc.directorOverrides), so
 *  APPLY honours it at APPROVE without a second override. */
export function storedOverride(calc: RentReviewCalc, check: OverridableCheck): StoredOverride | null {
  return calc.directorOverrides?.find((override) => override.check === check) ?? null;
}
