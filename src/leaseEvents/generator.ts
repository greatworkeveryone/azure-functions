// The lease events generator (PLAN §3.5, §3.6; WP32, WP33). Once a day it keeps
// each live lease's option and renewal events where the calendar says they are:
//
//   open_option       an option left, a window it can date (deadline = expiry −
//                     notice months, opening 6 months before), no event yet for
//                     this expiry, and the window opens within OPTION_HORIZON_DAYS
//                     (or is open now): a new event, window_not_open or window_open
//   open_window       window_not_open, and the window has opened
//   deadline_warning  window_open with no notice and the deadline
//                     OPTION_DEADLINE_WARNING_DAYS away or less: lease.option_deadline
//                     (attention; raising it again while one is live changes nothing)
//   lapse             window_not_open or window_open, and the deadline has
//                     passed: lapsed, and lease.option_lapsed to the directors
//   refer_renewal     the expiry is RENEWAL_DAYS away or less (or past: a lease
//                     held over), no option still live for it (none left, it
//                     lapsed or was rejected, or its window passed unrecorded)
//                     and no renewal event yet for this expiry: referred, and
//                     lease.renewal to the directors (authority)
//
// Selection is positive (database-safety rule 2): only tenancies stored as
// current or holdover, not archived, not test data (D9), with an expiry; and
// only the actions above, each checked against the event's own dates. A window
// that closed before the generator ever saw it opens no event and raises no
// lapse (no first-run wave of old lapses); its expiry reaches the directors as
// a renewal instead. Each write is its own transaction with its ledger row
// (system actor); a failure on one tenancy is reported and the rest carry on.
// Re-running changes nothing. At most LEASE_EVENTS_GENERATOR_MAX_ACTIONS writes
// a run (default 50), soonest date first, so a first run is paced over days.
//
// Opt-in because it writes in bulk:
//   LEASE_EVENTS_GENERATOR_ENABLED=true   writes
//   LEASE_EVENTS_GENERATOR_DRY_RUN=true   logs what it would do, with counts, and
//                                         writes nothing (wins over ENABLED)
//   neither                               does nothing and doesn't touch the database

import { randomUUID } from "node:crypto";
import type { Connection } from "tedious";
import { addDaysIso, daysBetweenIso, todayInDarwin } from "../darwinDate";
import { executeQuery, type SqlRow } from "../db";
import { isUniqueViolation } from "../escalation/errors";
import * as ledger from "../ledger";
import type { LedgerActor } from "../ledger";
import { isOpenLeaseEventState, type LeaseEventState, type LeaseEventType } from "../leaseEventMachine";
import type { OptionNoticeWindow } from "../leaseOptions";
import { sqlDateToIso } from "../nextReviewDate";
import { inTransaction } from "../rentReview/store";
import { invalidateTenantAndBuilding } from "../tenant-register-cache";
import { type LeasePolicyKey, LEASE_POLICIES, OPTION_DEADLINE_WARNING_DAYS, raiseLeaseEscalation } from "./escalations";
import { type LeaseOptions, leaseOptionsOf, optionWindowOf } from "./options";
import { insertEvent, moveEvent } from "./store";

export const GENERATOR_ACTOR: LedgerActor = { kind: "system", name: "leaseEventsGeneratorTimer" };

/** An option event opens this many days before its window does. */
export const OPTION_HORIZON_DAYS = 90;
/** A renewal opens at this many days to expiry, or fewer (PLAN §3.6). */
export const RENEWAL_DAYS = 180;
export const DEFAULT_MAX_ACTIONS = 50;

export function generatorMode(env: NodeJS.ProcessEnv = process.env): "dry-run" | "live" | "off" {
  if (env.LEASE_EVENTS_GENERATOR_DRY_RUN === "true") return "dry-run";
  return env.LEASE_EVENTS_GENERATOR_ENABLED === "true" ? "live" : "off";
}

export function maxActions(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number((env.LEASE_EVENTS_GENERATOR_MAX_ACTIONS ?? "").trim());
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_ACTIONS;
}

// ── Planning (pure) ─────────────────────────────────────────────────────────

export interface GeneratorTenancy {
  buildingId: number | null;
  expiry: string;
  options: LeaseOptions;
  tenantId: number;
  tenantName: string;
  window: OptionNoticeWindow;
}

export interface GeneratorEvent {
  deadlineOn: string | null;
  leaseEventId: string;
  leaseExpiry: string | null;
  state: LeaseEventState;
  tenantId: number;
  type: LeaseEventType;
  windowOpensOn: string | null;
}

interface ActionBase {
  buildingId: number | null;
  /** The date the action is about, for ordering (soonest first). */
  date: string;
  tenantId: number;
  tenantName: string;
}

export type GeneratorAction =
  | (ActionBase & { deadline: string; expiry: string; kind: "open_option"; opensAt: string; windowOpen: boolean })
  | (ActionBase & { kind: "open_window"; leaseEventId: string })
  | (ActionBase & { kind: "deadline_warning"; leaseEventId: string })
  | (ActionBase & { kind: "lapse"; leaseEventId: string })
  | (ActionBase & { expiry: string; kind: "refer_renewal" });

export interface GeneratorPlan {
  actions: GeneratorAction[];
  /** Open option events dated for an expiry the tenancy no longer has: left alone. */
  staleEvents: number;
  /** Tenancies whose option window closed before any event existed: left to the renewal rule. */
  unrecordedLapses: number;
}

function optionPlan(tenancy: GeneratorTenancy, events: readonly GeneratorEvent[], today: string, plan: GeneratorPlan): void {
  const base = { buildingId: tenancy.buildingId, tenantId: tenancy.tenantId, tenantName: tenancy.tenantName };
  const open = events.find((event) => event.type === "option_exercise" && isOpenLeaseEventState(event.state));
  if (open && open.leaseExpiry !== tenancy.expiry) {
    // The expiry was edited after the event opened: its dates no longer hold, so the
    // generator neither opens its window nor lapses it (recording a notice re-dates it).
    plan.staleEvents += 1;
    return;
  }
  if (open) {
    if ((open.state === "window_not_open" || open.state === "window_open") && open.deadlineOn !== null && today > open.deadlineOn) {
      plan.actions.push({ ...base, date: open.deadlineOn, kind: "lapse", leaseEventId: open.leaseEventId });
      return;
    }
    if (open.state === "window_not_open" && open.windowOpensOn !== null && today >= open.windowOpensOn) {
      plan.actions.push({ ...base, date: open.windowOpensOn, kind: "open_window", leaseEventId: open.leaseEventId });
    }
    const opened = open.state === "window_open" || (open.windowOpensOn !== null && today >= open.windowOpensOn);
    if (opened && open.deadlineOn !== null && daysBetweenIso(today, open.deadlineOn) <= OPTION_DEADLINE_WARNING_DAYS) {
      plan.actions.push({ ...base, date: open.deadlineOn, kind: "deadline_warning", leaseEventId: open.leaseEventId });
    }
    return;
  }
  const decided = events.some((event) => event.type === "option_exercise" && event.leaseExpiry === tenancy.expiry);
  const { deadline, opensAt, state } = tenancy.window;
  if (decided || deadline === null || opensAt === null || state === "none") return;
  if ((tenancy.options.remaining ?? 0) < 1) return;
  if (today > deadline) {
    plan.unrecordedLapses += 1;
    return;
  }
  if (today >= addDaysIso(opensAt, -OPTION_HORIZON_DAYS)) {
    plan.actions.push({ ...base, date: opensAt, deadline, expiry: tenancy.expiry, kind: "open_option", opensAt, windowOpen: today >= opensAt });
  }
}

/** No option is still live for this expiry: none left, or its event closed without an exercise, or its window passed. */
function optionStillLive(tenancy: GeneratorTenancy, events: readonly GeneratorEvent[]): boolean {
  if (events.some((event) => event.type === "option_exercise" && isOpenLeaseEventState(event.state))) return true;
  const forExpiry = events.find((event) => event.type === "option_exercise" && event.leaseExpiry === tenancy.expiry);
  if (forExpiry) return forExpiry.state === "exercised";
  return (tenancy.options.remaining ?? 0) > 0 && (tenancy.window.state === "not_yet" || tenancy.window.state === "open");
}

function renewalPlan(tenancy: GeneratorTenancy, events: readonly GeneratorEvent[], today: string, plan: GeneratorPlan): void {
  if (daysBetweenIso(today, tenancy.expiry) > RENEWAL_DAYS) return;
  const already = events.some(
    (event) => event.type === "renewal" && (isOpenLeaseEventState(event.state) || event.leaseExpiry === tenancy.expiry),
  );
  if (already || optionStillLive(tenancy, events)) return;
  plan.actions.push({
    buildingId: tenancy.buildingId,
    date: tenancy.expiry,
    expiry: tenancy.expiry,
    kind: "refer_renewal",
    tenantId: tenancy.tenantId,
    tenantName: tenancy.tenantName,
  });
}

/** What the generator should do. Pure: carrying out the actions and planning again yields none but live warnings. */
export function planLeaseEvents(tenancies: readonly GeneratorTenancy[], events: readonly GeneratorEvent[], today: string): GeneratorPlan {
  const byTenant = new Map<number, GeneratorEvent[]>();
  for (const event of events) byTenant.set(event.tenantId, [...(byTenant.get(event.tenantId) ?? []), event]);
  const plan: GeneratorPlan = { actions: [], staleEvents: 0, unrecordedLapses: 0 };
  for (const tenancy of tenancies) {
    const own = byTenant.get(tenancy.tenantId) ?? [];
    optionPlan(tenancy, own, today, plan);
    renewalPlan(tenancy, own, today, plan);
  }
  plan.actions.sort((a, b) => a.date.localeCompare(b.date) || a.tenantId - b.tenantId);
  return plan;
}

// ── Reading ─────────────────────────────────────────────────────────────────

// Positive selection: exactly the tenancies the rules above can act on.
const TENANCIES_SQL = `SELECT t.TenantId, t.BuildingId, t.LegalName, t.TradingName, t.Expiry,
    t.OptionPeriods, t.OptionNoticeMonths, t.OptionsTotal, t.OptionsRemaining, t.OptionTermMonths
  FROM dbo.Tenants t
  WHERE t.Status IN ('current', 'holdover') AND t.ArchivedAt IS NULL AND t.IsTest = 0 AND t.Expiry IS NOT NULL
  ORDER BY t.TenantId`;

const EVENTS_SQL = `SELECT e.LeaseEventId, e.TenantId, e.Type, e.State, e.LeaseExpiry, e.WindowOpensOn, e.DeadlineOn
  FROM dbo.LeaseEvents e
  INNER JOIN dbo.Tenants t ON t.TenantId = e.TenantId
  WHERE e.ArchivedAt IS NULL AND t.Status IN ('current', 'holdover') AND t.ArchivedAt IS NULL AND t.IsTest = 0`;

export function toGeneratorTenancy(row: SqlRow, today: string): GeneratorTenancy | null {
  const expiry = sqlDateToIso(row.Expiry);
  if (!expiry) return null;
  const trading = typeof row.TradingName === "string" ? row.TradingName.trim() : "";
  const legal = typeof row.LegalName === "string" ? row.LegalName.trim() : "";
  return {
    buildingId: row.BuildingId === null || row.BuildingId === undefined ? null : Number(row.BuildingId),
    expiry,
    options: leaseOptionsOf(row),
    tenantId: Number(row.TenantId),
    tenantName: trading || legal || `Tenancy ${row.TenantId}`,
    window: optionWindowOf(row, today),
  };
}

export function toGeneratorEvent(row: SqlRow): GeneratorEvent {
  return {
    deadlineOn: sqlDateToIso(row.DeadlineOn),
    leaseEventId: String(row.LeaseEventId),
    leaseExpiry: sqlDateToIso(row.LeaseExpiry),
    state: row.State as LeaseEventState,
    tenantId: Number(row.TenantId),
    type: row.Type as LeaseEventType,
    windowOpensOn: sqlDateToIso(row.WindowOpensOn),
  };
}

// ── Writing ─────────────────────────────────────────────────────────────────

/** "applied", or "raced" when another run or a person got there first. */
type Outcome = "applied" | "raced";

async function writeAction(connection: Connection, action: GeneratorAction, correlationId: string): Promise<{ escalate: LeasePolicyKey | null; leaseEventId: string; outcome: Outcome }> {
  const scope = { buildingId: action.buildingId, correlationId, tenantId: action.tenantId };
  if (action.kind === "deadline_warning") return { escalate: LEASE_POLICIES.optionDeadline, leaseEventId: action.leaseEventId, outcome: "applied" };
  if (action.kind === "open_window" || action.kind === "lapse") {
    const to: LeaseEventState = action.kind === "lapse" ? "lapsed" : "window_open";
    const from: LeaseEventState[] = action.kind === "lapse" ? ["window_not_open", "window_open"] : ["window_not_open"];
    const outcome = await inTransaction(connection, async () => {
      const extra = action.kind === "lapse" ? "Outcome = 'lapsed', DecidedAt = SYSUTCDATETIME()" : "";
      if (!(await moveEvent(connection, action.leaseEventId, from, to, extra))) return "raced" as const;
      await ledger.record(connection, {
        ...scope,
        action: action.kind === "lapse" ? "lease_event.lapsed" : "lease_event.window_open",
        actor: GENERATOR_ACTOR,
        after: { state: to },
        before: { states: from },
        ruleApplied: action.kind === "lapse" ? "deadline_passed_no_notice" : "window_opened",
        subject: { id: action.leaseEventId, type: "lease_event" },
      });
      return "applied" as const;
    });
    return { escalate: action.kind === "lapse" && outcome === "applied" ? LEASE_POLICIES.optionLapsed : null, leaseEventId: action.leaseEventId, outcome };
  }
  const leaseEventId = randomUUID();
  const option = action.kind === "open_option";
  const state: LeaseEventState = option ? (action.windowOpen ? "window_open" : "window_not_open") : "referred";
  try {
    await inTransaction(connection, async () => {
      await insertEvent(connection, {
        buildingId: action.buildingId,
        deadlineOn: option ? action.deadline : null,
        leaseEventId,
        leaseExpiry: action.expiry,
        state,
        tenantId: action.tenantId,
        type: option ? "option_exercise" : "renewal",
        windowOpensOn: option ? action.opensAt : null,
      });
      await ledger.record(connection, {
        ...scope,
        action: option ? "lease_event.open" : "lease_event.renewal_referred",
        actor: GENERATOR_ACTOR,
        after: option
          ? { deadlineOn: action.deadline, leaseExpiry: action.expiry, state, type: "option_exercise", windowOpensOn: action.opensAt }
          : { leaseExpiry: action.expiry, state, type: "renewal" },
        ruleApplied: option ? `option_window_within_${OPTION_HORIZON_DAYS}_days` : `expiry_within_${RENEWAL_DAYS}_days`,
        subject: { id: leaseEventId, type: "lease_event" },
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { escalate: null, leaseEventId, outcome: "raced" };
    throw error;
  }
  return { escalate: option ? null : LEASE_POLICIES.renewal, leaseEventId, outcome: "applied" };
}

// ── Running ─────────────────────────────────────────────────────────────────

export interface GeneratorReport {
  actions: GeneratorAction[];
  /** Planned but past this run's cap: the next run takes them. */
  deferred: number;
  dryRun: boolean;
  errors: Array<{ message: string; tenantId: number }>;
  escalationsRaised: number;
  raced: number;
  staleEvents: number;
  tenancies: number;
  today: string;
  unrecordedLapses: number;
  written: Record<GeneratorAction["kind"], number>;
}

export interface GeneratorRun {
  connection: Connection;
  dryRun: boolean;
  log: (message: string) => void;
  maxActions?: number;
  onError?: (error: unknown, tenantId: number) => void;
  today?: string;
  warn: (message: string) => void;
}

const describe = (action: GeneratorAction): string => {
  const who = `${action.tenantName} (tenancy ${action.tenantId})`;
  switch (action.kind) {
    case "open_option":
      return `open the option event for ${who}: window ${action.opensAt} to ${action.deadline}${action.windowOpen ? " (open now)" : ""}`;
    case "open_window":
      return `open the option window for ${who} (${action.date})`;
    case "deadline_warning":
      return `warn that ${who}'s option deadline is ${action.date}`;
    case "lapse":
      return `lapse ${who}'s option: the deadline ${action.date} passed with no notice`;
    case "refer_renewal":
      return `refer ${who}'s lease, expiring ${action.expiry}, to the directors for renewal`;
  }
};

/** One run: reads, plans and (unless `dryRun`) writes, one action at a time. A dry run reads only. */
export async function runLeaseEventsGenerator(run: GeneratorRun): Promise<GeneratorReport> {
  const today = run.today ?? todayInDarwin();
  const tenancies = (await executeQuery(run.connection, TENANCIES_SQL))
    .map((row) => toGeneratorTenancy(row, today))
    .filter((tenancy): tenancy is GeneratorTenancy => tenancy !== null);
  const events = (await executeQuery(run.connection, EVENTS_SQL)).map(toGeneratorEvent);
  const plan = planLeaseEvents(tenancies, events, today);
  const cap = run.maxActions ?? maxActions();
  const chosen = plan.actions.slice(0, cap);
  const report: GeneratorReport = {
    actions: chosen,
    deferred: plan.actions.length - chosen.length,
    dryRun: run.dryRun,
    errors: [],
    escalationsRaised: 0,
    raced: 0,
    staleEvents: plan.staleEvents,
    tenancies: tenancies.length,
    today,
    unrecordedLapses: plan.unrecordedLapses,
    written: { deadline_warning: 0, lapse: 0, open_option: 0, open_window: 0, refer_renewal: 0 },
  };
  const verb = run.dryRun ? "would" : "will";
  for (const action of chosen) run.log(`leaseEventsGenerator: ${verb} ${describe(action)}`);

  if (run.dryRun) {
    for (const action of chosen) report.written[action.kind] += 1;
  } else {
    const correlationId = ledger.newCorrelationId();
    for (const action of chosen) {
      try {
        const done = await writeAction(run.connection, action, correlationId);
        if (done.outcome === "raced") {
          report.raced += 1;
          continue;
        }
        report.written[action.kind] += 1;
        if (action.buildingId !== null && action.kind !== "deadline_warning") invalidateTenantAndBuilding(action.tenantId, action.buildingId);
        if (done.escalate) {
          const raised = await raiseLeaseEscalation(run.connection, {
            actor: GENERATOR_ACTOR,
            log: run.warn,
            policyKey: done.escalate,
            target: { buildingId: action.buildingId, leaseEventId: done.leaseEventId, tenantId: action.tenantId },
          });
          if (raised) report.escalationsRaised += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report.errors.push({ message, tenantId: action.tenantId });
        run.warn(`leaseEventsGenerator: tenancy ${action.tenantId} failed: ${message}`);
        run.onError?.(error, action.tenantId);
      }
    }
  }
  run.log(
    `leaseEventsGenerator: ${run.dryRun ? "dry run, nothing written. " : ""}${tenancies.length} tenancies checked on ${today}: ` +
      Object.entries(report.written).map(([kind, n]) => `${kind} ${n}`).join(", ") +
      `; ${report.deferred} past the cap of ${cap}, ${report.unrecordedLapses} windows that closed unrecorded, ` +
      `${report.staleEvents} option events dated for an old expiry (left alone), ` +
      `${report.raced} raced, ${report.errors.length} failed`,
  );
  return report;
}
