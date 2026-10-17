// What a tenancy is charged under its schedule (PLAN WP26c, D24). Pure.
//
// KEEP IN SYNC: the frontend mirrors this file with WP26c's frontend half (next
// to src/helpers/rentScheduleCore.ts in command-centre). The parity fixtures'
// `charges` blocks (src/__tests__/rent-schedule-parity.fixtures.json here,
// src/__tests__/helpers/rent-schedule-parity.fixtures.json there) are identical
// and asserted by Jest on both sides. Change both or neither.
//
// The schedule rows (scheduledRateStepLogic.ts computeScheduleRows) always say
// what the lease says. Rent relief a director ratified is an overlay on them,
// never a row:
//
//   { id, from, to, kind, value, scope }
//     from        the first day of the relief
//     to          its last day (inclusive): the day after, the charge is the
//                 lease's again
//     kind        percent     value % off each charge in scope (0 < value ≤ 100)
//                 amount      value $ a year off the rent
//                 fixed_rent  the rent charged is value $ a year
//     scope       rent, ahac, carparks, misc_fees, one or more; amount and
//                 fixed_rent are the rent's only
//
// The lease figure in force on a day is the schedule's own: the latest settled
// (not pending) row dated on or before that day, as resolveCurrentRent reads it;
// for a schedule that opens with a review row, the stored base rent
// (RentPerAnnum) until its first settled row. A review dated inside a relief
// still changes the lease figure, and the relief applies on top of whatever the
// lease figure is. The timeline is cut wherever the row in force or the set of
// reliefs changes, and each period carries both figures for every charge:
//
//   { from, to, stepId, reliefIds, lease, charged }
//     from      null: since before the schedule's first row (the base rent)
//     to        exclusive; null: open-ended
//     stepId    the row in force; null for the base rent
//     lease, charged  { rent, ahac, carparks, miscFees }: a year's worth, to the
//               cent; null where the tenancy has no such charge (no AHAC), or
//               where the caller gave no car park and misc fee figures
//
// A relief never takes a charge below $0. If two ratified reliefs ever covered
// one charge on one day (a request that would is refused), the one starting
// first, then the lower id, applies.
//
// Changes still awaiting a director (relief requests, reviews waiting for
// approval) are markers, never figures: each row lists the markers whose dates
// touch its own period [its date, the next row's date); a marker without a `to`
// touches the row its `from` falls in. Billing reads only the periods, so it
// never bills a pending change.
//
// Amounts over a stretch of days (chargesOver) are pro rata by day on a 365-day
// year, each slice to the cent, as review arrears are (rentReview/arrears.ts).

import { addDaysIso, addMonthsClamped, daysBetweenIso, isIsoDate } from "./darwinDate";
import type { ScheduleRow } from "./scheduledRateStepLogic";

export type ReliefKind = "amount" | "fixed_rent" | "percent";
export type ChargeScope = "ahac" | "carparks" | "misc_fees" | "rent";

export const RELIEF_KINDS: readonly ReliefKind[] = ["percent", "amount", "fixed_rent"];
/** In the order the engine applies them and the screens list them. */
export const CHARGE_SCOPES: readonly ChargeScope[] = ["rent", "ahac", "carparks", "misc_fees"];

export interface RentRelief {
  from: string;
  /** The ScheduleChangeRequests.RequestId it was ratified from. */
  id: string;
  kind: ReliefKind;
  scope: ChargeScope[];
  to: string;
  value: number;
  /** Display only (the engine ignores them): when and by whom it was ratified, and why it was asked for. */
  ratifiedAt?: string;
  ratifiedByName?: string;
  reason?: string;
}

/** A year's worth of each charge, to the cent; null where there is none. */
export interface Charges {
  ahac: number | null;
  carparks: number | null;
  miscFees: number | null;
  rent: number | null;
}

export interface ChargePeriod {
  charged: Charges;
  /** First day; null: since before the schedule's first row (the stored base rent). */
  from: string | null;
  lease: Charges;
  /** The ratified reliefs that set a charged figure in this period. */
  reliefIds: string[];
  /** The row in force; null for the stored base rent. */
  stepId: string | null;
  /** Exclusive end; null: open-ended. */
  to: string | null;
}

/** A change awaiting a director, as a schedule shows it: never in a figure. */
export interface PendingChangeMarker {
  from: string | null;
  kind: string;
  requestId: string;
  summary: string;
  /** Last day (inclusive); null: from `from` on (a review). */
  to: string | null;
}

/** Car park and misc fee totals a year for one row (cascade.ts ancillariesByRow; the frontend's own schedules). */
export interface RowAncillaries {
  carparks: number | null;
  miscFees: number | null;
}

export interface ChargedRow {
  /** Changes awaiting a director that touch this row's own period. */
  pendingChanges: PendingChangeMarker[];
  /** The periods this row is in force for; none while it is pending (the rent before it carries on). */
  periods: ChargePeriod[];
  stepId: string;
}

export interface ChargeSchedule {
  periods: ChargePeriod[];
  /** Aligned with the rows given. */
  rows: ChargedRow[];
}

export interface ChargeInput {
  /** Aligned with the rows; leave out to charge rent and AHAC only. */
  ancillaries?: ReadonlyArray<RowAncillaries | null | undefined>;
  /** Tenants.RentPerAnnum: the base rent of a schedule that opens with a review row, or has none. */
  fallbackAnnual: number;
  pending?: readonly PendingChangeMarker[];
  /** Ratified reliefs only. */
  reliefs?: readonly RentRelief[];
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

const SCOPE_KEY: Record<ChargeScope, keyof Charges> = { ahac: "ahac", carparks: "carparks", misc_fees: "miscFees", rent: "rent" };
const KEYS: ReadonlyArray<keyof Charges> = ["rent", "ahac", "carparks", "miscFees"];

/** The first day a relief no longer applies. */
export const reliefEnd = (relief: Pick<RentRelief, "to">): string => addDaysIso(relief.to, 1);

const byStart = (a: RentRelief, b: RentRelief): number => a.from.localeCompare(b.from) || a.id.localeCompare(b.id);

/** What a relief leaves of one charge (a year's worth). */
export function relieve(amount: number | null, relief: RentRelief, scope: ChargeScope): number | null {
  if (amount === null) return null;
  if (relief.kind === "percent") return r2((amount * (100 - relief.value)) / 100);
  if (scope !== "rent") return amount;
  return relief.kind === "amount" ? r2(Math.max(0, amount - relief.value)) : r2(relief.value);
}

interface Span {
  from: string | null;
  lease: Charges;
  stepId: string | null;
  to: string | null;
}

const baseCharges = (fallbackAnnual: number): Charges => ({ ahac: null, carparks: null, miscFees: null, rent: r2(fallbackAnnual) });

/** Where each row (or the base rent) is the one in force, as resolveCurrentRent reads it. */
function leaseSpans(rows: readonly ScheduleRow[], input: ChargeInput): Span[] {
  const first = rows[0];
  if (!first) return [{ from: null, lease: baseCharges(input.fallbackAnnual), stepId: null, to: null }];
  const settled = rows.map((row, index) => ({ index, row })).filter(({ row }) => !row.pending);
  const spans: Span[] = [];
  if (first.step.methodKind !== "commencement" && input.fallbackAnnual > 0) {
    spans.push({ from: null, lease: baseCharges(input.fallbackAnnual), stepId: null, to: settled[0]?.row.step.effectiveFrom ?? null });
  }
  settled.forEach(({ index, row }, k) => {
    const to = settled[k + 1]?.row.step.effectiveFrom ?? null;
    // A row another one dated the same day replaces is never in force.
    if (to !== null && to <= row.step.effectiveFrom) return;
    const ancillaries = input.ancillaries?.[index] ?? null;
    spans.push({
      from: row.step.effectiveFrom,
      lease: { ahac: row.ahacAnnual, carparks: ancillaries?.carparks ?? null, miscFees: ancillaries?.miscFees ?? null, rent: row.annual },
      stepId: row.step.id,
      to,
    });
  });
  return spans;
}

/** One period: the reliefs in force from its first day, each charge relieved by the first that covers it. */
function periodOf(span: Span, from: string | null, to: string | null, reliefs: readonly RentRelief[]): ChargePeriod {
  const active = from === null ? [] : reliefs.filter((relief) => relief.from <= from && from < reliefEnd(relief));
  const charged: Charges = { ...span.lease };
  const applied: string[] = [];
  for (const scope of CHARGE_SCOPES) {
    const relief = active.find((candidate) => candidate.scope.includes(scope));
    if (!relief) continue;
    const key = SCOPE_KEY[scope];
    charged[key] = relieve(span.lease[key], relief, scope);
    if (!applied.includes(relief.id)) applied.push(relief.id);
  }
  return { charged, from, lease: { ...span.lease }, reliefIds: active.filter((relief) => applied.includes(relief.id)).map((relief) => relief.id), stepId: span.stepId, to };
}

/** Whether a marker's dates touch [from, to). */
function touches(marker: PendingChangeMarker, from: string, to: string | null): boolean {
  if (marker.from === null) return false;
  const end = addDaysIso(marker.to ?? marker.from, 1);
  return (to === null || marker.from < to) && end > from;
}

/**
 * The charge timeline of a schedule: `rows` from computeScheduleRows, the
 * ratified reliefs laid over them, and the pending changes marked on the rows
 * they touch. See the header for the rules.
 */
export function computeCharges(rows: readonly ScheduleRow[], input: ChargeInput): ChargeSchedule {
  const reliefs = [...(input.reliefs ?? [])].sort(byStart);
  const cuts = [...new Set(reliefs.flatMap((relief) => [relief.from, reliefEnd(relief)]))].sort();
  const periods: ChargePeriod[] = [];
  for (const span of leaseSpans(rows, input)) {
    const inside = cuts.filter((cut) => (span.from === null || cut > span.from) && (span.to === null || cut < span.to));
    const bounds: Array<string | null> = [span.from, ...inside, span.to];
    for (let k = 0; k < bounds.length - 1; k++) periods.push(periodOf(span, bounds[k], bounds[k + 1], reliefs));
  }
  const pending = input.pending ?? [];
  return {
    periods,
    rows: rows.map((row, index) => {
      const to = rows[index + 1]?.step.effectiveFrom ?? null;
      return {
        pendingChanges: pending.filter((marker) => touches(marker, row.step.effectiveFrom, to)),
        periods: periods.filter((period) => period.stepId === row.step.id),
        stepId: row.step.id,
      };
    }),
  };
}

/** The period in force on `day`, or null when nothing is charged then (the schedule hasn't started, or its rent is unknown). */
export function chargedOn(schedule: ChargeSchedule, day: string): ChargePeriod | null {
  return schedule.periods.find((period) => (period.from === null || period.from <= day) && (period.to === null || day < period.to)) ?? null;
}

export interface ChargeSlice {
  charged: Charges;
  days: number;
  from: string;
  lease: Charges;
  reliefIds: string[];
  stepId: string | null;
  /** Exclusive. */
  to: string;
}

export interface ChargeTotals {
  charged: Charges;
  lease: Charges;
  slices: ChargeSlice[];
}

const emptyCharges = (): Charges => ({ ahac: null, carparks: null, miscFees: null, rent: null });

function proRata(charges: Charges, days: number): Charges {
  const out = emptyCharges();
  for (const key of KEYS) {
    const value = charges[key];
    out[key] = value === null ? null : r2((value * days) / 365);
  }
  return out;
}

function add(total: Charges, part: Charges): void {
  for (const key of KEYS) {
    const value = part[key];
    if (value !== null) total[key] = r2((total[key] ?? 0) + value);
  }
}

/** What the lease asks and what is charged from `from` to `to` (exclusive),
 *  slice by slice, each pro rata by day on a 365-day year and to the cent. */
export function chargesOver(schedule: ChargeSchedule, from: string, to: string): ChargeTotals {
  const totals: ChargeTotals = { charged: emptyCharges(), lease: emptyCharges(), slices: [] };
  for (const period of schedule.periods) {
    const start = period.from === null || period.from < from ? from : period.from;
    const end = period.to === null || period.to > to ? to : period.to;
    if (start >= end) continue;
    const days = daysBetweenIso(start, end);
    const slice: ChargeSlice = {
      charged: proRata(period.charged, days),
      days,
      from: start,
      lease: proRata(period.lease, days),
      reliefIds: [...period.reliefIds],
      stepId: period.stepId,
      to: end,
    };
    totals.slices.push(slice);
    add(totals.lease, slice.lease);
    add(totals.charged, slice.charged);
  }
  return totals;
}

export interface ReliefForgone {
  /** Per charge, over the relief's days: what the lease asks less what is charged with the relief. */
  byCharge: Charges;
  /** The whole of it: positive = money forgone. */
  total: number;
}

/**
 * What one relief gives up over its own days: the charges with every other
 * ratified relief, less the charges with this one too. Worked on the schedule
 * as it stands; a review applied later inside the relief changes the charge,
 * not this figure.
 */
export function reliefForgone(rows: readonly ScheduleRow[], input: ChargeInput, relief: RentRelief): ReliefForgone {
  const others = (input.reliefs ?? []).filter((candidate) => candidate.id !== relief.id);
  const end = reliefEnd(relief);
  const without = chargesOver(computeCharges(rows, { ...input, pending: [], reliefs: others }), relief.from, end).charged;
  const withIt = chargesOver(computeCharges(rows, { ...input, pending: [], reliefs: [...others, relief] }), relief.from, end).charged;
  const byCharge = emptyCharges();
  let total = 0;
  for (const key of KEYS) {
    const before = without[key];
    const after = withIt[key];
    if (before === null && after === null) continue;
    byCharge[key] = r2((before ?? 0) - (after ?? 0));
    total = r2(total + byCharge[key]);
  }
  return { byCharge, total };
}

// ── Reading and checking a relief ────────────────────────────────────────────

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** The longest one relief may run: its last day falls before this many months from its first. */
export const RELIEF_MAX_MONTHS = 60;
export const RELIEF_AMOUNT_MAX = 1e10;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const realDate = (value: unknown): value is string => isIsoDate(value);

export type ReliefShapeResult =
  | { ok: true; relief: Omit<RentRelief, "id"> }
  | { error: string; ok: false };

/**
 * The shape of a relief a person asks for: { from, to, kind, value, scope }.
 * Dates are real ISO dates with `to` on or after `from`, at most five years
 * apart; percent is above 0 and at most 100; amount and fixed_rent are dollars
 * a year (fixed_rent may be 0) and the rent's only. Whether the schedule can
 * carry it (a charge to relieve, no overlap) is the request's own check.
 */
export function validateReliefShape(raw: unknown): ReliefShapeResult {
  if (!isPlainObject(raw)) return { error: "relief must be { from, to, kind, value, scope }", ok: false };
  const extra = Object.keys(raw).find((key) => !["from", "kind", "scope", "to", "value"].includes(key));
  if (extra) return { error: `relief has no "${extra}"`, ok: false };
  const { from, kind, scope, to, value } = raw;
  if (!realDate(from)) return { error: "relief.from must be a date (YYYY-MM-DD)", ok: false };
  if (!realDate(to)) return { error: "relief.to must be a date (YYYY-MM-DD): the relief's last day", ok: false };
  if (to < from) return { error: "relief.to can't be before relief.from", ok: false };
  if (to >= addMonthsClamped(from, RELIEF_MAX_MONTHS)) return { error: "A relief can cover at most five years", ok: false };
  if (typeof kind !== "string" || !(RELIEF_KINDS as readonly string[]).includes(kind)) {
    return { error: `relief.kind must be one of ${RELIEF_KINDS.join(", ")}`, ok: false };
  }
  if (!Array.isArray(scope) || scope.length === 0 || !scope.every((s) => typeof s === "string" && (CHARGE_SCOPES as readonly string[]).includes(s))) {
    return { error: `relief.scope must list one or more of ${CHARGE_SCOPES.join(", ")}`, ok: false };
  }
  const scopes = CHARGE_SCOPES.filter((s) => (scope as string[]).includes(s));
  if (scopes.length !== scope.length) return { error: "relief.scope lists a charge twice", ok: false };
  if (typeof value !== "number" || !Number.isFinite(value)) return { error: "relief.value must be a number", ok: false };
  if (kind === "percent" && !(value > 0 && value <= 100)) return { error: "A percentage relief must be more than 0% and at most 100%", ok: false };
  if (kind !== "percent") {
    if (scopes.length !== 1 || scopes[0] !== "rent") {
      return { error: "An amount or a fixed rent relieves the rent only; use a percentage for other charges", ok: false };
    }
    if (kind === "amount" && !(value > 0 && value < RELIEF_AMOUNT_MAX)) return { error: "An amount relief must be more than $0 a year", ok: false };
    if (kind === "fixed_rent" && !(value >= 0 && value < RELIEF_AMOUNT_MAX)) return { error: "A fixed rent must be $0 a year or more", ok: false };
  }
  return { ok: true, relief: { from, kind: kind as ReliefKind, scope: scopes, to, value: kind === "percent" ? value : r2(value) } };
}

/** Two reliefs share a day and a charge. */
export function reliefsOverlap(a: Pick<RentRelief, "from" | "scope" | "to">, b: Pick<RentRelief, "from" | "scope" | "to">): boolean {
  return a.from <= b.to && b.from <= a.to && a.scope.some((scope) => b.scope.includes(scope));
}

/** Tenants.RentReliefs; [] when empty or not a list. Entries that aren't reliefs are left out. */
export function parseReliefs(raw: string | null | undefined): RentRelief[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): RentRelief[] => {
      if (!isPlainObject(entry) || typeof entry.id !== "string" || !ID_RE.test(entry.id)) return [];
      const shape = validateReliefShape({ from: entry.from, kind: entry.kind, scope: entry.scope, to: entry.to, value: entry.value });
      if (!shape.ok) return [];
      const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);
      const ratifiedAt = text(entry.ratifiedAt);
      const ratifiedByName = text(entry.ratifiedByName);
      const reason = text(entry.reason);
      return [{ ...shape.relief, id: entry.id, ...(ratifiedAt ? { ratifiedAt } : {}), ...(ratifiedByName ? { ratifiedByName } : {}), ...(reason ? { reason } : {}) }];
    });
  } catch {
    return [];
  }
}
