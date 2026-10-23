// Lease option rules: what the free-text "Option periods" field means and when
// the tenant's window to give notice is open. Pure and time-zone free: dates
// are ISO "YYYY-MM-DD" strings, month maths is integer arithmetic, and
// comparisons are text comparisons of zero-padded dates. WP32 backfills
// Tenants.OptionsTotal / OptionTermMonths with parseOptionPeriods, so a change
// to its grammar is a change to that backfill.
//
// Ported identically from command-centre src/helpers/leaseOptions.ts (WP19), the
// only difference being the tenant type, which here names the three fields it
// reads instead of importing the frontend's RegisterTenant. Keep the two in
// step: the frontend's tests are copied into src/__tests__/leaseOptions.test.ts.

export interface ParsedOptionPeriods {
  /** How many options the lease grants. */
  count: number;
  /** Length of each option, in months. */
  termMonths: number;
}

/**
 * none: nothing to exercise, or no window to date (see `optionNoticeWindow`);
 * not_yet: the window has not opened; open: notice can be given today;
 * closed: the deadline has passed, including after the lease has expired.
 */
export type OptionNoticeState = "closed" | "none" | "not_yet" | "open";

export interface OptionNoticeWindow {
  /** Last day notice can be given: expiry minus `optionNoticeMonths`. Null when `state` is "none". */
  deadline: string | null;
  /** First day the window is open: the deadline minus six months. Null when `state` is "none". */
  opensAt: string | null;
  state: OptionNoticeState;
}

export interface OptionNoticeTenant {
  expiry?: string | null;
  optionNoticeMonths?: number | null;
  optionPeriods?: string | null;
  /** Tenants.OptionsRemaining (WP32), when known: 0 means nothing is left to
   *  exercise whatever the free text says; null falls back to parsing it. */
  optionsRemaining?: number | null;
}

const WINDOW_OPENS_MONTHS_BEFORE_DEADLINE = 6;

type TermUnit = "months" | "years";

interface OptionSegment {
  /** No multiplier and no unit: "5" alone could be a count or a term. */
  bare: boolean;
  count: number;
  unit: TermUnit | null;
  value: number;
}

const YEAR_UNITS = new Set(["y", "yr", "yrs", "year", "years"]);
const MONTH_UNITS = new Set(["m", "mo", "mos", "mth", "mths", "month", "months"]);
// "[count x] term [unit]": "2 x 5 years", "1x3yrs", "5 years", "5".
const SEGMENT = /^(?:(\d+)\s*x\s*)?(\d+(?:\.\d+)?)\s*([a-z]*)$/;
const SEGMENT_SEPARATOR = /\s*(?:\+|&|\band\b)\s*/;

function termUnit(token: string): TermUnit | null {
  if (YEAR_UNITS.has(token)) return "years";
  if (MONTH_UNITS.has(token)) return "months";
  return null;
}

function readSegment(part: string): OptionSegment | null {
  const match = part.match(SEGMENT);
  if (!match) return null;
  const [, countText, valueText, token] = match;
  const unit = token ? termUnit(token) : null;
  if (token && !unit) return null;
  return {
    bare: !countText && !token,
    count: countText ? Number(countText) : 1,
    unit,
    value: Number(valueText),
  };
}

function termMonthsOf(segment: OptionSegment, fallback: TermUnit): number {
  const unit = segment.unit ?? fallback;
  return Math.round(unit === "years" ? segment.value * 12 : segment.value);
}

/**
 * Reads the option text staff type into the register — "2 x 5 years", "1x3yrs",
 * "5 + 5" (two five-year options). A unit-less term is years; in a sum, a unit
 * stated once ("6 + 6 months") applies to every term. Fails closed: anything
 * that is not clearly "N options of T" returns null,
 * including "Nil", "None", "N/A", empty text, free prose, a lone number ("5"),
 * zero counts or terms, and sums of different terms ("5 + 3" — the shape has
 * one term per lease). WP32 lists the unparseable rows for accounts to fix.
 */
export function parseOptionPeriods(
  text: string | null | undefined,
): ParsedOptionPeriods | null {
  if (!text) return null;
  const cleaned = text
    .toLowerCase()
    .replace(/[×*]/g, "x")
    .replace(/\b(?:each|options?)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const segments: OptionSegment[] = [];
  for (const part of cleaned.split(SEGMENT_SEPARATOR)) {
    const segment = readSegment(part);
    if (!segment) return null;
    segments.push(segment);
  }
  if (segments.length === 1 && segments[0].bare) return null;

  const statedUnits = segments.flatMap((item) => (item.unit ? [item.unit] : []));
  const fallback = statedUnits.at(-1) ?? "years";
  const termMonths = termMonthsOf(segments[0], fallback);
  let count = 0;
  for (const segment of segments) {
    if (segment.count < 1 || termMonthsOf(segment, fallback) !== termMonths) {
      return null;
    }
    count += segment.count;
  }
  return termMonths >= 1 ? { count, termMonths } : null;
}

interface IsoParts {
  day: number;
  month: number;
  year: number;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysIn(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1];
}

/** Reads the date part of "YYYY-MM-DD" (or a full ISO timestamp); null if it isn't a real date. */
function readIsoDate(value: string | null | undefined): IsoParts | null {
  const match = (value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) return null;
  return { day, month, year };
}

function formatIso({ day, month, year }: IsoParts): string {
  const pad = (num: number, size: number) => String(num).padStart(size, "0");
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** Whole months earlier or later; a day the target month lacks falls to its last day (31 Aug − 6 months = 28/29 Feb). */
function shiftMonths(parts: IsoParts, delta: number): IsoParts {
  const index = parts.year * 12 + (parts.month - 1) + delta;
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  return { day: Math.min(parts.day, daysIn(year, month)), month, year };
}

/** Options still to exercise: the structured count when known, else the text's. */
function hasOptionsLeft(tenant: OptionNoticeTenant): boolean {
  const remaining = tenant.optionsRemaining;
  if (typeof remaining === "number" && Number.isFinite(remaining)) return remaining > 0;
  return parseOptionPeriods(tenant.optionPeriods) !== null;
}

/**
 * Where `today` ("YYYY-MM-DD") sits against the tenant's option notice window.
 * The deadline is expiry minus `optionNoticeMonths`; the window opens six
 * months before that. Both days are inside the window. State is "none" when
 * there is nothing to date or nothing to exercise: the option text doesn't
 * parse (see `parseOptionPeriods`), `optionNoticeMonths` is not a whole number
 * of months of at least 1 (0 is how an unset notice period reads), or `expiry`
 * / `today` aren't real dates. A known `optionsRemaining` (WP32) decides on its
 * own: 0 or less is "none" even when the text still reads "2 x 5 years"; more
 * than 0 dates the window even when the text doesn't parse.
 */
export function optionNoticeWindow(
  tenant: OptionNoticeTenant,
  today: string,
): OptionNoticeWindow {
  const expiry = readIsoDate(tenant.expiry);
  const current = readIsoDate(today);
  const noticeMonths = tenant.optionNoticeMonths;
  if (
    !expiry ||
    !current ||
    !hasOptionsLeft(tenant) ||
    noticeMonths == null ||
    !Number.isInteger(noticeMonths) ||
    noticeMonths < 1
  ) {
    return { deadline: null, opensAt: null, state: "none" };
  }

  const deadlineParts = shiftMonths(expiry, -noticeMonths);
  const deadline = formatIso(deadlineParts);
  const opensAt = formatIso(
    shiftMonths(deadlineParts, -WINDOW_OPENS_MONTHS_BEFORE_DEADLINE),
  );
  const todayIso = formatIso(current);

  if (todayIso < opensAt) return { deadline, opensAt, state: "not_yet" };
  if (todayIso <= deadline) return { deadline, opensAt, state: "open" };
  return { deadline, opensAt, state: "closed" };
}

/** True when `date` ("YYYY-MM-DD") falls inside the window, both ends included (C10). */
export function isInsideOptionWindow(window: Pick<OptionNoticeWindow, "deadline" | "opensAt">, date: string): boolean {
  const day = readIsoDate(date);
  if (!day || window.opensAt === null || window.deadline === null) return false;
  const iso = formatIso(day);
  return iso >= window.opensAt && iso <= window.deadline;
}

export interface OptionTermDates {
  /** The new expiry: the option's last day. */
  newExpiry: string;
  /** The first day of the option term: the day after the current expiry. */
  optionStart: string;
  /** The day after the new expiry (the schedule's exclusive end). */
  termEnd: string;
}

function addDays(parts: IsoParts, days: number): IsoParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + days * 86_400_000);
  return { day: date.getUTCDate(), month: date.getUTCMonth() + 1, year: date.getUTCFullYear() };
}

/**
 * The option term that follows `expiry`: it starts the next day and runs
 * `termMonths` whole months from there, so its last day is the day before the
 * same date `termMonths` later. Worked from the start, not the expiry, so a
 * lease ending on 28 Feb runs to the end of February (29 Feb in a leap year)
 * and one ending on 30 Apr to 30 Apr. Null when the expiry isn't a real date
 * or the term isn't a whole number of months of at least 1.
 */
export function optionTermDates(expiry: string | null | undefined, termMonths: number | null | undefined): OptionTermDates | null {
  const end = readIsoDate(expiry);
  if (!end || termMonths == null || !Number.isInteger(termMonths) || termMonths < 1) return null;
  const start = addDays(end, 1);
  const termEnd = shiftMonths(start, termMonths);
  return { newExpiry: formatIso(addDays(termEnd, -1)), optionStart: formatIso(start), termEnd: formatIso(termEnd) };
}

/** How the rent moves during an option term (WP32): the method of the review
 *  at the option's start, and of the reviews after it. */
export type OptionMethodKind = "cpi" | "fixed" | "market" | "other";

export interface OptionTermPlan {
  /** Increase % of a fixed review; ignored for the other methods. */
  fixedPercent?: number | null;
  /** Months between reviews during the term (the lease's interval; 12 when unset). */
  intervalMonths?: number | null;
  /** The reviews after the first. */
  ongoingMethod: OptionMethodKind;
  /** The review on the option's first day ("market" when the lease says the option starts at market). */
  startMethod: OptionMethodKind;
}

/** A schedule row an option term adds, in the schedule engine's shape. */
export interface OptionTermStep {
  effectiveFrom: string;
  /** Exclusive end. */
  effectiveTo: string;
  id: string;
  methodKind: OptionMethodKind;
  ratePercent: number;
}

const DEFAULT_INTERVAL_MONTHS = 12;

/**
 * The schedule rows for an option term (PLAN §3.5 APPLY: "option-term schedule
 * steps per the lease method"): one review row on the option's first day with
 * the start method, then one every `intervalMonths` with the ongoing method,
 * each ending (exclusively) where the next begins and the last on the day after
 * the new expiry. A fixed row carries its percentage; every other row starts at
 * 0 and waits for its review (a market or other row reads "rate not set", a CPI
 * row "index missing") until the review workflow settles it. Pure: `newId`
 * names each row. Empty when the term can't be dated.
 */
export function buildOptionTermSteps(
  expiry: string | null | undefined,
  termMonths: number | null | undefined,
  plan: OptionTermPlan,
  newId: () => string,
): OptionTermStep[] {
  const dates = optionTermDates(expiry, termMonths);
  if (!dates || termMonths == null) return [];
  const start = readIsoDate(dates.optionStart) as IsoParts;
  const interval =
    plan.intervalMonths != null && Number.isInteger(plan.intervalMonths) && plan.intervalMonths >= 1
      ? plan.intervalMonths
      : DEFAULT_INTERVAL_MONTHS;
  const rate = (method: OptionMethodKind): number =>
    method === "fixed" && typeof plan.fixedPercent === "number" && Number.isFinite(plan.fixedPercent) ? plan.fixedPercent : 0;
  const steps: OptionTermStep[] = [];
  for (let months = 0; months < termMonths; months += interval) {
    const from = formatIso(shiftMonths(start, months));
    const nextMonths = Math.min(months + interval, termMonths);
    const to = nextMonths >= termMonths ? dates.termEnd : formatIso(shiftMonths(start, nextMonths));
    const method = months === 0 ? plan.startMethod : plan.ongoingMethod;
    steps.push({ effectiveFrom: from, effectiveTo: to, id: newId(), methodKind: method, ratePercent: rate(method) });
  }
  return steps;
}
