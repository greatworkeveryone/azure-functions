// APPLY for an option exercise (PLAN §3.5): in the caller's transaction, so it
// all commits or none of it does.
//
//   1. the tenancy row is locked (UPDLOCK); refused if archived or vacated; the
//      lease's expiry must still be the one the notice was recorded against
//      (409 expiry_changed), with an option left (C10: 422 no_options)
//   2. C3: the schedule is signed off, unless a director overrides it with a reason
//   3. the option term is dated from the day after the expiry (leaseOptions.ts
//      optionTermDates: month-end safe, Darwin calendar dates, no clock) and its
//      rows built per the lease method recorded with the notice
//      (buildOptionTermSteps); a schedule that already has rows on or after the
//      option's first day is refused (422 schedule_conflict) rather than merged
//   4. the rows are written through the schedule engine (placeStep closes the
//      open-ended row before the first one), every changed row in the change
//      log; Expiry = the new expiry, OptionsRemaining − 1 (OptionsTotal and
//      OptionTermMonths filled when they were still unrecorded), ScheduleVersion
//      + 1 with the sign-off kept (D7: a workflow apply, not a manual edit),
//      NextReviewDate derived; a stored holdover goes back to current
//   5. an option that starts at market spawns its market review through WP25's
//      engine: a scheduled review on the option's first day when the tenancy has
//      no open review (SCHEDULE, ledgered); when one is already open on that day
//      its COMMENCE reads "market" from the new row (C2); when an earlier review
//      is open, the generator schedules this one once that settles (recorded)
//   6. the event -> exercised, and lease_event.option_exercised in the ledger
//      with every value before and after
//   7. an open renewal event on the tenancy is cancelled: the lease no longer
//      expires when it said
// The caller writes the director override rows and does the after-commit work.

import { randomUUID } from "node:crypto";
import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery, type SqlParam, type SqlRow } from "../db";
import * as ledger from "../ledger";
import type { LedgerActor } from "../ledger";
import { buildOptionTermSteps, type OptionMethodKind, optionTermDates } from "../leaseOptions";
import { sqlDateToIso } from "../nextReviewDate";
import { insertRentScheduleChangeLog } from "../rentScheduleChangeLog";
import { derivedNextReview } from "../rentReview/reviewTenancy";
import { placeStep, stepChanges } from "../rentReview/stepPlan";
import { insertScheduledReview } from "../rentReview/store";
import { diffSteps, parseSteps, type ScheduledRateStep } from "../scheduledRateStepLogic";
import { scheduleSignOffFromRow } from "../scheduleSignOff";
import type { OptionTerms } from "./dto";
import { LeaseEventError } from "./http";
import { leaseOptionsOf } from "./options";
import { markDecided, moveEvent, openEventForUpdate, openReviewForUpdate } from "./store";

export type OverridableCheck = "not_signed_off" | "option_window";

export interface ApplyOptionInput {
  actor: Extract<LedgerActor, { kind: "user" }>;
  actorOid: string;
  correlationId: string;
  /** The checks a director is overriding now, with the reason (D23). */
  directorOverride: { checks: ReadonlySet<OverridableCheck>; reason: string } | null;
  /** The event row, locked by the caller. */
  event: SqlRow;
  /** The tenancy row, locked by the caller. */
  tenancy: SqlRow;
  today: string;
}

export interface MarketReviewOutcome {
  kind: "deferred" | "existing" | "none" | "scheduled";
  reviewId: string | null;
  scheduledFor: string | null;
}

export interface ApplyOptionResult {
  buildingId: number;
  marketReview: MarketReviewOutcome;
  newExpiry: string;
  nextReviewDate: string | null;
  optionsRemaining: number;
  /** The renewal event the exercise superseded, if one was open. */
  supersededRenewal: string | null;
  tenantId: number;
}

const OPTION_METHODS: readonly OptionMethodKind[] = ["cpi", "fixed", "market", "other"];

/** The terms recorded with the notice, checked; a bad_request when they can't be read. */
export function readStoredTerms(event: SqlRow): OptionTerms {
  let terms: Partial<OptionTerms> | null = null;
  try {
    terms = typeof event.Terms === "string" ? (JSON.parse(event.Terms) as Partial<OptionTerms>) : null;
  } catch {
    terms = null;
  }
  const method = (value: unknown): value is OptionMethodKind => OPTION_METHODS.includes(value as OptionMethodKind);
  if (
    !terms ||
    !Number.isInteger(terms.termMonths) ||
    !Number.isInteger(terms.intervalMonths) ||
    !method(terms.startMethod) ||
    !method(terms.ongoingMethod) ||
    typeof terms.optionStart !== "string" ||
    typeof terms.newExpiry !== "string"
  ) {
    throw new LeaseEventError("invalid_state", "This notice has no option term recorded with it. Record the notice again.");
  }
  return terms as OptionTerms;
}

/** The tenancy columns an exercise changes, as a ledger snapshot. */
function tenancySnapshot(row: SqlRow) {
  const int = (value: unknown) => (value === null || value === undefined ? null : Number(value));
  return {
    expiry: sqlDateToIso(row.Expiry),
    nextReviewDate: sqlDateToIso(row.NextReviewDate),
    optionsRemaining: int(row.OptionsRemaining),
    optionsTotal: int(row.OptionsTotal),
    optionTermMonths: int(row.OptionTermMonths),
    scheduleVersion: Number(row.ScheduleVersion ?? 0),
    status: typeof row.Status === "string" ? row.Status : null,
  };
}

export function refuseClosedTenancy(tenancy: SqlRow): void {
  if (tenancy.ArchivedAt !== null && tenancy.ArchivedAt !== undefined) {
    throw new LeaseEventError("tenancy_archived", "This tenancy has been archived, so its lease events can't be changed.");
  }
  if (tenancy.Status === "vacated") {
    throw new LeaseEventError("tenancy_vacated", "This tenancy has been vacated, so its lease events can't be changed.");
  }
}

/** Step 5: the market review the option's first day needs. */
async function spawnMarketReview(
  connection: Connection,
  input: { actor: LedgerActor; buildingId: number; correlationId: string; leaseEventId: string; optionStart: string; tenantId: number },
): Promise<MarketReviewOutcome> {
  const open = await openReviewForUpdate(connection, input.tenantId);
  if (open) {
    const scheduledFor = sqlDateToIso(open.ScheduledFor);
    return { kind: scheduledFor === input.optionStart ? "existing" : "deferred", reviewId: String(open.ReviewId), scheduledFor };
  }
  const reviewId = randomUUID();
  await insertScheduledReview(connection, {
    buildingId: input.buildingId,
    method: "market",
    reviewId,
    scheduledFor: input.optionStart,
    tenantId: input.tenantId,
  });
  await ledger.record(connection, {
    action: "rent_review.schedule",
    actor: input.actor,
    after: { leaseEventId: input.leaseEventId, method: "market", methodSource: "step", scheduledFor: input.optionStart, state: "scheduled" },
    buildingId: input.buildingId,
    correlationId: input.correlationId,
    ruleApplied: "option_exercise_market",
    subject: { id: reviewId, type: "rent_review" },
    tenantId: input.tenantId,
  });
  return { kind: "scheduled", reviewId, scheduledFor: input.optionStart };
}

async function writeTenancyForOption(
  connection: Connection,
  write: {
    actorName: string;
    actorOid: string;
    newExpiry: string;
    nextReviewDate: string | null;
    optionsRemaining: number;
    optionsTotal: number;
    optionTermMonths: number;
    statusToCurrent: boolean;
    steps: ScheduledRateStep[];
    tenantId: number;
  },
): Promise<number> {
  const sets = [
    "ScheduledRateSteps = @Steps",
    "Expiry = @Expiry",
    "OptionsRemaining = @OptionsRemaining",
    "OptionsTotal = @OptionsTotal",
    "OptionTermMonths = @OptionTermMonths",
  ];
  const params: SqlParam[] = [
    { name: "TenantId", type: TYPES.Int, value: write.tenantId },
    { name: "Steps", type: TYPES.NVarChar, value: JSON.stringify(write.steps) },
    { name: "Expiry", type: TYPES.Date, value: write.newExpiry },
    { name: "OptionsRemaining", type: TYPES.Int, value: write.optionsRemaining },
    { name: "OptionsTotal", type: TYPES.Int, value: write.optionsTotal },
    { name: "OptionTermMonths", type: TYPES.Int, value: write.optionTermMonths },
    { name: "UpdatedById", type: TYPES.NVarChar, value: write.actorOid },
    { name: "UpdatedByName", type: TYPES.NVarChar, value: write.actorName },
  ];
  if (write.nextReviewDate !== null) {
    sets.push("NextReviewDate = @NextReviewDate");
    params.push({ name: "NextReviewDate", type: TYPES.Date, value: write.nextReviewDate });
  }
  if (write.statusToCurrent) sets.push("Status = 'current'");
  const rows = await executeQuery(
    connection,
    `UPDATE dbo.Tenants SET ${sets.join(", ")},
       ScheduleVersion = ScheduleVersion + 1,
       UpdatedAt = SYSUTCDATETIME(),
       UpdatedById = @UpdatedById,
       UpdatedByName = @UpdatedByName
     OUTPUT INSERTED.ScheduleVersion
     WHERE TenantId = @TenantId`,
    params,
  );
  return Number(rows[0]?.ScheduleVersion);
}

export async function applyOptionExercise(connection: Connection, input: ApplyOptionInput): Promise<ApplyOptionResult> {
  const { event, tenancy } = input;
  const leaseEventId = String(event.LeaseEventId);
  const tenantId = Number(tenancy.TenantId);
  const buildingId = Number(tenancy.BuildingId);
  refuseClosedTenancy(tenancy);

  const expiry = sqlDateToIso(tenancy.Expiry);
  const recordedExpiry = sqlDateToIso(event.LeaseExpiry);
  if (!expiry || expiry !== recordedExpiry) {
    throw new LeaseEventError(
      "expiry_changed",
      "The lease's expiry has changed since this notice was recorded. Check the tenancy, then record the notice again.",
      { expiry, recordedExpiry },
    );
  }
  const options = leaseOptionsOf(tenancy);
  if (options.remaining === null || options.remaining < 1) {
    throw new LeaseEventError("no_options", "This lease has no options left to exercise.");
  }
  const terms = readStoredTerms(event);
  const dates = optionTermDates(expiry, terms.termMonths);
  if (!dates || dates.optionStart !== terms.optionStart || dates.newExpiry !== terms.newExpiry) {
    throw new LeaseEventError("expiry_changed", "The option term no longer matches the lease. Record the notice again.");
  }

  // C3, or a director's override of it.
  const signOff = scheduleSignOffFromRow(tenancy);
  const signOffOverridden = !signOff && input.directorOverride?.checks.has("not_signed_off") === true;
  if (!signOff && !signOffOverridden) {
    throw new LeaseEventError("not_signed_off", "This tenancy's schedule isn't signed off yet. Sign it off, then approve.", {
      directorCanOverride: true,
    });
  }

  const steps = parseSteps(tenancy.ScheduledRateSteps as string | null | undefined);
  const clash = steps.filter((step) => step.effectiveFrom >= dates.optionStart).map((step) => step.effectiveFrom).sort()[0];
  if (clash) {
    throw new LeaseEventError(
      "schedule_conflict",
      `The rent schedule already has rows from ${clash}, on or after the option's first day. Check them before exercising the option.`,
      { from: clash },
    );
  }

  const termSteps = buildOptionTermSteps(expiry, terms.termMonths, terms, randomUUID);
  let nextSteps: ScheduledRateStep[] = steps;
  for (const row of termSteps) nextSteps = placeStep(nextSteps, row).steps;

  const changedBy = { changedById: input.actorOid, changedByName: input.actor.name };
  const scheduleChanges: Array<{ changeId: string; kind: "added" | "updated"; stepId: string }> = [];
  for (const change of stepChanges(steps, nextSteps, termSteps[0]?.id ?? "")) {
    scheduleChanges.push({
      changeId: await insertRentScheduleChangeLog(connection, {
        ...changedBy,
        buildingId,
        changeKind: change.kind,
        diff: change.before ? diffSteps(change.before, change.after) : null,
        stepId: change.after.id,
        stepSnapshot: change.after,
        tenantId,
      }),
      kind: change.kind,
      stepId: change.after.id,
    });
  }

  const before = tenancySnapshot(tenancy);
  const optionsRemaining = options.remaining - 1;
  const next = derivedNextReview({ ...tenancy, Expiry: dates.newExpiry }, nextSteps, {}, input.today);
  const statusToCurrent = tenancy.Status === "holdover" && dates.newExpiry >= input.today;
  const scheduleVersion = await writeTenancyForOption(connection, {
    actorName: input.actor.name,
    actorOid: input.actorOid,
    newExpiry: dates.newExpiry,
    nextReviewDate: next?.after ?? null,
    optionsRemaining,
    optionsTotal: options.total ?? options.remaining,
    optionTermMonths: terms.termMonths,
    statusToCurrent,
    steps: nextSteps,
    tenantId,
  });

  const marketReview: MarketReviewOutcome =
    terms.startMethod === "market"
      ? await spawnMarketReview(connection, {
          actor: input.actor,
          buildingId,
          correlationId: input.correlationId,
          leaseEventId,
          optionStart: dates.optionStart,
          tenantId,
        })
      : { kind: "none", reviewId: null, scheduledFor: null };

  const from = String(event.State) as "awaiting_approval" | "notice_received";
  const details = {
    marketReview,
    newExpiry: dates.newExpiry,
    optionStart: dates.optionStart,
    optionsRemaining,
    stepIds: termSteps.map((step) => step.id),
  };
  const moved = await markDecided(connection, leaseEventId, [from], "exercised", {
    decider: { name: input.actor.name, userId: input.actor.userId },
    details,
    outcome: "exercised",
    reason: input.directorOverride?.reason ?? null,
  });
  if (!moved) throw new LeaseEventError("invalid_state", "This notice just moved on, so it wasn't approved.");

  const nextReviewDate = next?.after ?? before.nextReviewDate;
  await ledger.record(connection, {
    action: "lease_event.option_exercised",
    actor: input.actor,
    after: {
      ...details,
      scheduleChanges,
      signOff: signOff ? { at: signOff.at, by: signOff.by } : { overriddenBy: input.actor.name, reason: input.directorOverride?.reason ?? null },
      state: "exercised",
      steps: termSteps,
      tenancy: {
        expiry: dates.newExpiry,
        nextReviewDate,
        optionsRemaining,
        optionsTotal: options.total ?? options.remaining,
        optionTermMonths: terms.termMonths,
        scheduleVersion,
        status: statusToCurrent ? "current" : before.status,
      },
      terms,
    },
    before: { state: from, tenancy: before },
    buildingId,
    correlationId: input.correlationId,
    ruleApplied: from === "notice_received" ? "late_notice_director_override" : "notice_in_window",
    subject: { id: leaseEventId, type: "lease_event" },
    tenantId,
  });

  // 7. The lease no longer ends when an open renewal referral says.
  const renewal = await openEventForUpdate(connection, tenantId, "renewal");
  let supersededRenewal: string | null = null;
  if (renewal) {
    supersededRenewal = String(renewal.LeaseEventId);
    const reason = "Superseded: the tenant exercised an option, so the lease runs on";
    if (await moveEvent(connection, supersededRenewal, ["referred"], "cancelled", "Outcome = 'cancelled', OutcomeReason = @Reason", [
      { name: "Reason", type: TYPES.NVarChar, value: reason },
    ])) {
      await ledger.record(connection, {
        action: "lease_event.cancel",
        actor: input.actor,
        after: { state: "cancelled", supersededBy: leaseEventId },
        before: { state: "referred" },
        buildingId,
        correlationId: input.correlationId,
        reason,
        ruleApplied: "superseded_by_option_exercise",
        subject: { id: supersededRenewal, type: "lease_event" },
        tenantId,
      });
    } else {
      supersededRenewal = null;
    }
  }

  return { buildingId, marketReview, newExpiry: dates.newExpiry, nextReviewDate, optionsRemaining, supersededRenewal, tenantId };
}
