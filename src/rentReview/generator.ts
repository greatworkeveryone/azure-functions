// The review generator (PLAN WP25, §3.1 SCHEDULE and OPEN_WINDOW): keeps exactly
// one open review instance per live tenancy (not vacated, not archived), for the
// tenancy's next review date.
//
// The date is the one WP23b derives for today (deriveNextReviewDate), read the
// way the screens and getReviewsDue read it, never the stored NextReviewDate
// column, which only moves on a write or a recompute. A tenancy with nothing to
// derive from keeps its stored date (as tenantRowToApi does); one with neither
// is skipped.
//
// A lease that says it has no review clause (Tenants.ReviewType 'none') gets no
// new review, unless a schedule step dated on the derived date names a method:
// that step still wins, so a fixed step still schedules a fixed review. A blank
// or unrecognised review type still becomes an `other` review, because someone
// has to classify the lease. (A tenancy that already has an open review is not
// touched by this: the review runs on as below.)
//
//   no open review          -> SCHEDULE: a new instance, `scheduled`
//   scheduled, inside the   -> OPEN_WINDOW: scheduled -> due
//   window (REVIEW_WINDOW_DAYS, default 60)
//   anything else           -> nothing. An open review dated differently from
//                              today's derived date is counted (`drift`) and
//                              left alone: nothing in the machine moves a date,
//                              and re-dating a review someone may be working on
//                              is a person's decision (cancel or waive it).
//
// An instance created already inside the window is first SCHEDULEd and then
// OPEN_WINDOWed, each in its own transaction with its own ledger row (system
// actor), so the history reads like the machine and a failure between the two
// is finished by the next run. Re-running changes nothing.
//
// Opt-in because it writes in bulk (database-safety rule 2):
//   RENT_REVIEW_GENERATOR_ENABLED=true   writes
//   RENT_REVIEW_GENERATOR_DRY_RUN=true   logs what it would create or move, with
//                                        counts, and writes nothing (wins over ENABLED)
//   neither                              does nothing and doesn't touch the database

import { randomUUID } from "node:crypto";
import type { Connection } from "tedious";
import { daysBetweenIso, todayInDarwin } from "../darwinDate";
import { executeQuery, type SqlRow } from "../db";
import { isUniqueViolation } from "../escalation/errors";
import * as ledger from "../ledger";
import type { LedgerActor } from "../ledger";
import { deriveNextReviewDate, nextReviewInputFromRow, RESOLVED_REVIEW_DATES_SQL, sqlDateToIso } from "../nextReviewDate";
import {
  canTransition,
  OPEN_RENT_REVIEW_STATES,
  type RentReviewMethod,
  type RentReviewState,
} from "../rentReviewMachine";
import { parseSteps } from "../scheduledRateStepLogic";
import { invalidateTenantAndBuilding } from "../tenant-register-cache";
import { hasNoReviewClause, type MethodSource, resolveReviewMethod, stepOnDate } from "./method";
import { inTransaction, insertScheduledReview, markWindowOpen } from "./store";

export const DEFAULT_REVIEW_WINDOW_DAYS = 60;

/** The system actor every generator ledger row carries. */
export const GENERATOR_ACTOR: LedgerActor = { kind: "system", name: "tenancyReviewScheduleTimer" };

/** REVIEW_WINDOW_DAYS: how many days before a review's date it becomes `due`. */
export function reviewWindowDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.REVIEW_WINDOW_DAYS ?? "").trim();
  if (raw === "") return DEFAULT_REVIEW_WINDOW_DAYS;
  const days = Number(raw);
  return Number.isInteger(days) && days >= 0 && days <= 366 ? days : DEFAULT_REVIEW_WINDOW_DAYS;
}

export function generatorMode(env: NodeJS.ProcessEnv = process.env): "dry-run" | "live" | "off" {
  if (env.RENT_REVIEW_GENERATOR_DRY_RUN === "true") return "dry-run";
  return env.RENT_REVIEW_GENERATOR_ENABLED === "true" ? "live" : "off";
}

// ── Planning (pure) ─────────────────────────────────────────────────────────

export interface TenancyFacts {
  /** Tenants.ArchivedAt is set (D4): out of scope, like a vacated tenancy. */
  archived: boolean;
  buildingId: number;
  /** Tenants.Status as stored. */
  status: string;
  tenantId: number;
  tenantName: string;
  row: SqlRow;
}

export interface OpenReview {
  method: string | null;
  reviewId: string;
  scheduledFor: string;
  state: RentReviewState;
}

export type GeneratorAction =
  | {
      buildingId: number;
      daysUntil: number;
      kind: "schedule";
      method: RentReviewMethod;
      methodSource: MethodSource;
      /** True when the date is already inside the window, so OPEN_WINDOW follows. */
      opensWindow: boolean;
      scheduledFor: string;
      tenantId: number;
      tenantName: string;
    }
  | {
      buildingId: number;
      daysUntil: number;
      kind: "open_window";
      reviewId: string;
      scheduledFor: string;
      tenantId: number;
      tenantName: string;
    };

export interface DriftedReview {
  derived: string;
  reviewId: string;
  scheduledFor: string;
  state: RentReviewState;
  tenantId: number;
}

/** Why a tenancy was left out: archived or vacated; a lease with no review clause
 *  (ReviewType 'none', and no step naming a method); or no date to review. */
export type SkipReason = "archived" | "no_review_clause" | "no_review_date" | "vacated";

export interface GeneratorPlan {
  actions: GeneratorAction[];
  drift: DriftedReview[];
  /** Tenancies with nothing to do. */
  skipped: Array<{ reason: SkipReason; tenantId: number }>;
  unchanged: number;
}

/** The date a tenancy's next review falls on, derived for `today`; null when there is none. */
export function nextReviewFor(row: SqlRow, today: string): string | null {
  const steps = parseSteps(row.ScheduledRateSteps as string | null | undefined);
  const input = nextReviewInputFromRow(row, steps, today);
  return deriveNextReviewDate(input) ?? input.storedNextReviewDate;
}

/**
 * What the generator should do for these tenancies given the open reviews they
 * already have. Pure: applying the actions and planning again yields no actions.
 */
export function planGenerator(
  tenancies: readonly TenancyFacts[],
  openByTenant: ReadonlyMap<number, OpenReview>,
  today: string,
  windowDays: number,
): GeneratorPlan {
  const plan: GeneratorPlan = { actions: [], drift: [], skipped: [], unchanged: 0 };
  const within = (date: string): boolean => daysBetweenIso(today, date) <= windowDays;

  for (const tenancy of tenancies) {
    if (tenancy.status === "vacated") {
      plan.skipped.push({ reason: "vacated", tenantId: tenancy.tenantId });
      continue;
    }
    if (tenancy.archived) {
      plan.skipped.push({ reason: "archived", tenantId: tenancy.tenantId });
      continue;
    }
    const derived = nextReviewFor(tenancy.row, today);
    if (derived === null) {
      plan.skipped.push({ reason: "no_review_date", tenantId: tenancy.tenantId });
      continue;
    }

    const open = openByTenant.get(tenancy.tenantId);
    if (!open) {
      if (!canTransition(null, "SCHEDULE")) continue;
      const steps = parseSteps(tenancy.row.ScheduledRateSteps as string | null | undefined);
      const reviewType = typeof tenancy.row.ReviewType === "string" ? tenancy.row.ReviewType : null;
      const { method, source } = resolveReviewMethod({ reviewType, step: stepOnDate(steps, derived) });
      // "No review clause" and no step on that date naming a method: nothing to review,
      // rather than an `other` review every year. A step that names a method got a
      // source other than "fallback" above and is scheduled as usual.
      if (source === "fallback" && hasNoReviewClause(reviewType)) {
        plan.skipped.push({ reason: "no_review_clause", tenantId: tenancy.tenantId });
        continue;
      }
      plan.actions.push({
        buildingId: tenancy.buildingId,
        daysUntil: daysBetweenIso(today, derived),
        kind: "schedule",
        method,
        methodSource: source,
        opensWindow: within(derived),
        scheduledFor: derived,
        tenantId: tenancy.tenantId,
        tenantName: tenancy.tenantName,
      });
      continue;
    }

    let acted = false;
    if (canTransition(open.state, "OPEN_WINDOW", { withinWindow: within(open.scheduledFor) })) {
      plan.actions.push({
        buildingId: tenancy.buildingId,
        daysUntil: daysBetweenIso(today, open.scheduledFor),
        kind: "open_window",
        reviewId: open.reviewId,
        scheduledFor: open.scheduledFor,
        tenantId: tenancy.tenantId,
        tenantName: tenancy.tenantName,
      });
      acted = true;
    }
    if (open.scheduledFor !== derived) {
      plan.drift.push({
        derived,
        reviewId: open.reviewId,
        scheduledFor: open.scheduledFor,
        state: open.state,
        tenantId: tenancy.tenantId,
      });
    } else if (!acted) {
      plan.unchanged++;
    }
  }
  return plan;
}

// ── Reading ─────────────────────────────────────────────────────────────────

const TENANCIES_SQL = `SELECT t.TenantId, t.BuildingId, t.LegalName, t.TradingName, t.Status, t.ArchivedAt,
    t.Commencement, t.LastReviewDate, t.ReviewIntervalMonths, t.NextReviewDate, t.ReviewType,
    t.ScheduledRateSteps, ${RESOLVED_REVIEW_DATES_SQL}
  FROM dbo.Tenants t
  WHERE t.Status <> 'vacated' AND t.ArchivedAt IS NULL
  ORDER BY t.TenantId`;

const OPEN_STATE_LIST = OPEN_RENT_REVIEW_STATES.map((state) => `'${state}'`).join(", ");

const OPEN_REVIEWS_SQL = `SELECT ReviewId, TenantId, ScheduledFor, State, Method
  FROM dbo.RentReviews
  WHERE State IN (${OPEN_STATE_LIST})`;

export function toTenancyFacts(row: SqlRow): TenancyFacts {
  const trading = typeof row.TradingName === "string" ? row.TradingName.trim() : "";
  const legal = typeof row.LegalName === "string" ? row.LegalName.trim() : "";
  return {
    archived: row.ArchivedAt !== null && row.ArchivedAt !== undefined,
    buildingId: Number(row.BuildingId),
    row,
    status: String(row.Status),
    tenantId: Number(row.TenantId),
    tenantName: trading || legal || `Tenancy ${row.TenantId}`,
  };
}

export async function loadTenancies(connection: Connection): Promise<TenancyFacts[]> {
  return (await executeQuery(connection, TENANCIES_SQL)).map(toTenancyFacts);
}

export async function loadOpenReviews(connection: Connection): Promise<Map<number, OpenReview>> {
  const open = new Map<number, OpenReview>();
  for (const row of await executeQuery(connection, OPEN_REVIEWS_SQL)) {
    open.set(Number(row.TenantId), {
      method: typeof row.Method === "string" ? row.Method : null,
      reviewId: String(row.ReviewId),
      scheduledFor: sqlDateToIso(row.ScheduledFor) ?? "",
      state: row.State as RentReviewState,
    });
  }
  return open;
}

// ── Writing ─────────────────────────────────────────────────────────────────

/** "applied", or "raced" when another run or a person got there first and this one wrote nothing. */
export type ApplyOutcome = "applied" | "raced";

interface WindowTarget {
  buildingId: number;
  reviewId: string;
  tenantId: number;
}

/** OPEN_WINDOW on one review, in its own transaction. */
async function openWindow(
  connection: Connection,
  target: WindowTarget,
  windowDays: number,
  correlationId: string,
): Promise<ApplyOutcome> {
  return inTransaction(connection, async () => {
    // Only if it is still `scheduled`: a person may have commenced it since the plan was made.
    if (!(await markWindowOpen(connection, target.reviewId))) return "raced";
    await ledger.record(connection, {
      action: "rent_review.open_window",
      actor: GENERATOR_ACTOR,
      after: { state: "due" },
      before: { state: "scheduled" },
      buildingId: target.buildingId,
      correlationId,
      ruleApplied: `review_window_${windowDays}_days`,
      subject: { id: target.reviewId, type: "rent_review" },
      tenantId: target.tenantId,
    });
    return "applied";
  });
}

async function schedule(
  connection: Connection,
  action: Extract<GeneratorAction, { kind: "schedule" }>,
  correlationId: string,
): Promise<{ outcome: ApplyOutcome; reviewId: string }> {
  const reviewId = randomUUID();
  try {
    const outcome = await inTransaction(connection, async () => {
      await insertScheduledReview(connection, {
        buildingId: action.buildingId,
        method: action.method,
        reviewId,
        scheduledFor: action.scheduledFor,
        tenantId: action.tenantId,
      });
      await ledger.record(connection, {
        action: "rent_review.schedule",
        actor: GENERATOR_ACTOR,
        after: { method: action.method, methodSource: action.methodSource, scheduledFor: action.scheduledFor, state: "scheduled" },
        buildingId: action.buildingId,
        correlationId,
        ruleApplied: "derived_next_review",
        subject: { id: reviewId, type: "rent_review" },
        tenantId: action.tenantId,
      });
      return "applied" as const;
    });
    return { outcome, reviewId };
  } catch (error) {
    // The filtered unique index: the tenancy already has an open review.
    if (isUniqueViolation(error)) return { outcome: "raced", reviewId };
    throw error;
  }
}

/** What an action did. `raced`: a write was skipped because another run or a
 *  person got there first. `windowError`: the review was scheduled but opening
 *  its window failed; it stays `scheduled` and the next run opens it. */
export interface ApplyResult {
  raced: boolean;
  scheduled: boolean;
  windowError?: unknown;
  windowOpened: boolean;
}

/** Carries out one planned action, each transition in its own transaction. */
export async function applyAction(
  connection: Connection,
  action: GeneratorAction,
  windowDays: number,
  correlationId: string,
): Promise<ApplyResult> {
  if (action.kind === "open_window") {
    const outcome = await openWindow(connection, action, windowDays, correlationId);
    if (outcome === "applied") invalidateTenantAndBuilding(action.tenantId, action.buildingId);
    return { raced: outcome === "raced", scheduled: false, windowOpened: outcome === "applied" };
  }
  const created = await schedule(connection, action, correlationId);
  if (created.outcome === "raced") return { raced: true, scheduled: false, windowOpened: false };
  invalidateTenantAndBuilding(action.tenantId, action.buildingId);
  if (!action.opensWindow) return { raced: false, scheduled: true, windowOpened: false };
  try {
    const opened = await openWindow(
      connection,
      { buildingId: action.buildingId, reviewId: created.reviewId, tenantId: action.tenantId },
      windowDays,
      correlationId,
    );
    return { raced: opened === "raced", scheduled: true, windowOpened: opened === "applied" };
  } catch (windowError) {
    return { raced: false, scheduled: true, windowError, windowOpened: false };
  }
}

// ── Running ─────────────────────────────────────────────────────────────────

export interface GeneratorReport {
  actions: GeneratorAction[];
  drift: DriftedReview[];
  dryRun: boolean;
  errors: Array<{ message: string; tenantId: number }>;
  /** Writes skipped because another run or a person got there first. */
  raced: number;
  scheduled: number;
  skipped: GeneratorPlan["skipped"];
  tenancies: number;
  today: string;
  unchanged: number;
  windowDays: number;
  windowsOpened: number;
}

export interface GeneratorRun {
  connection: Connection;
  dryRun: boolean;
  log: (message: string) => void;
  onError?: (error: unknown, tenantId: number) => void;
  today?: string;
  warn: (message: string) => void;
  windowDays: number;
}

const MAX_LOGGED_ACTIONS = 200;

function describeAction(action: GeneratorAction): string {
  return action.kind === "schedule"
    ? `schedule ${action.tenantName} (tenancy ${action.tenantId}) for ${action.scheduledFor}, ${action.method}` +
        `${action.opensWindow ? ", then open its window" : ""}`
    : `open the window on ${action.tenantName} (tenancy ${action.tenantId}), review ${action.scheduledFor}`;
}

/**
 * One run. Reads every live (not vacated, not archived) tenancy and every open review, plans, and
 * (unless `dryRun`) carries the plan out one action at a time: a failure on one
 * tenancy is reported and the rest carry on. A dry run reads only.
 */
export async function runReviewGenerator(run: GeneratorRun): Promise<GeneratorReport> {
  const today = run.today ?? todayInDarwin();
  const tenancies = await loadTenancies(run.connection);
  const open = await loadOpenReviews(run.connection);
  const plan = planGenerator(tenancies, open, today, run.windowDays);

  const report: GeneratorReport = {
    actions: plan.actions,
    drift: plan.drift,
    dryRun: run.dryRun,
    errors: [],
    raced: 0,
    scheduled: 0,
    skipped: plan.skipped,
    tenancies: tenancies.length,
    today,
    unchanged: plan.unchanged,
    windowDays: run.windowDays,
    windowsOpened: 0,
  };

  const verb = run.dryRun ? "would" : "will";
  plan.actions.slice(0, MAX_LOGGED_ACTIONS).forEach((action) => run.log(`rentReviewGenerator: ${verb} ${describeAction(action)}`));
  if (plan.actions.length > MAX_LOGGED_ACTIONS) {
    run.log(`rentReviewGenerator: ...and ${plan.actions.length - MAX_LOGGED_ACTIONS} more`);
  }
  for (const drifted of plan.drift) {
    run.warn(
      `rentReviewGenerator: tenancy ${drifted.tenantId} has a ${drifted.state} review dated ${drifted.scheduledFor} ` +
        `but its next review now derives to ${drifted.derived}; left as it is`,
    );
  }

  const toSchedule = plan.actions.filter((action) => action.kind === "schedule").length;
  const toOpen = plan.actions.length - toSchedule + plan.actions.filter((a) => a.kind === "schedule" && a.opensWindow).length;
  if (run.dryRun) {
    report.scheduled = toSchedule;
    report.windowsOpened = toOpen;
  } else {
    const correlationId = ledger.newCorrelationId();
    const fail = (error: unknown, tenantId: number): void => {
      const message = error instanceof Error ? error.message : String(error);
      report.errors.push({ message, tenantId });
      run.warn(`rentReviewGenerator: tenancy ${tenantId} failed: ${message}`);
      run.onError?.(error, tenantId);
    };
    for (const action of plan.actions) {
      try {
        const result = await applyAction(run.connection, action, run.windowDays, correlationId);
        if (result.raced) report.raced++;
        if (result.scheduled) report.scheduled++;
        if (result.windowOpened) report.windowsOpened++;
        if (result.windowError !== undefined) fail(result.windowError, action.tenantId);
      } catch (error) {
        fail(error, action.tenantId);
      }
    }
  }

  run.log(
    `rentReviewGenerator: ${run.dryRun ? "dry run, nothing written. " : ""}${tenancies.length} tenancies checked on ${today} ` +
      `(window ${run.windowDays} days): ${report.scheduled} ${run.dryRun ? "to schedule" : "scheduled"}, ` +
      `${report.windowsOpened} ${run.dryRun ? "windows to open" : "windows opened"}, ${report.unchanged} unchanged, ` +
      `${report.skipped.length} skipped, ${report.drift.length} dated differently from the derivation, ` +
      `${report.raced} raced, ${report.errors.length} failed`,
  );
  return report;
}
