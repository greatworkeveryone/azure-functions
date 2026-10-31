// SLA clocks for escalations (PLAN §3.7). Pure: no I/O, and never the process
// time zone.
//
// Darwin is UTC+09:30 all year (ACST, no daylight saving), so every Darwin
// boundary is plain arithmetic on that fixed offset. The Function host runs UTC
// and WEBSITE_TIME_ZONE stays unset; the same code gives the same answer on a
// laptop in Copenhagen.
//
// Business hours are Monday to Friday, 08:30 to 16:30 Darwin (Connor, 31 Oct 2026). Weekends are
// skipped, and so are the public holidays in ESCALATION_HOLIDAYS (comma-separated
// YYYY-MM-DD, Darwin dates) and the active office closures in dbo.OfficeClosures (migration 191). "8h = 1 business day" in
// the policy table is one full business day: 8 business hours from Monday 08:30
// ends Monday 16:30.

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export const DARWIN_OFFSET_MS = 9.5 * HOUR_MS;
export const BUSINESS_DAY_START_MINUTES = 8 * 60 + 30;
const BUSINESS_DAY_END_MINUTES = 16 * 60 + 30;
/** PLAN §3.7: policy hours count 8 to a business day. */
export const BUSINESS_HOURS_PER_DAY = 8;

// A holiday list that covers this many days in a row is a typo, not a calendar.
const MAX_SKIPPED_DAYS = 3660;

export type Holidays = ReadonlySet<string>;

export const NO_HOLIDAYS: Holidays = new Set<string>();

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

function isRealDate(key: string): boolean {
  const m = key.match(DATE_KEY);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
}

/** ESCALATION_HOLIDAYS text -> the valid dates, plus the entries that were not
 *  real YYYY-MM-DD dates so a caller can say so. */
export function parseHolidays(raw: string | null | undefined): { holidays: Holidays; invalid: string[] } {
  const holidays = new Set<string>();
  const invalid: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    if (isRealDate(entry)) holidays.add(entry);
    else invalid.push(entry);
  }
  return { holidays, invalid };
}

let cachedRaw: string | undefined;
let cachedLoaded: Holidays = NO_HOLIDAYS;
let cachedHolidays: Holidays = NO_HOLIDAYS;
let loadedClosureDays: Holidays = NO_HOLIDAYS;

/**
 * The office-closure days last read from the database (officeClosures/calendar.ts). Sites that load the
 * calendar pass it on explicitly; this is the fallback for the deep call sites that default to
 * holidaysFromEnv(), so a closure still counts once any request or sweep in this process has loaded it.
 */
export function setLoadedClosureDays(days: Holidays): void {
  loadedClosureDays = days;
}

/** Holidays from the environment, plus any closure days loaded from the database. Parsed once per distinct value. */
export function holidaysFromEnv(env: NodeJS.ProcessEnv = process.env): Holidays {
  const raw = env.ESCALATION_HOLIDAYS ?? "";
  if (raw !== cachedRaw || loadedClosureDays !== cachedLoaded) {
    cachedRaw = raw;
    cachedLoaded = loadedClosureDays;
    const fromEnv = parseHolidays(raw).holidays;
    cachedHolidays = loadedClosureDays.size === 0 ? fromEnv : new Set([...fromEnv, ...loadedClosureDays]);
  }
  return cachedHolidays;
}

/** Days since 1970-01-01 of the Darwin calendar day an instant falls on. */
function darwinDayIndex(instant: Date): number {
  return Math.floor((instant.getTime() + DARWIN_OFFSET_MS) / DAY_MS);
}

function dateKeyOf(dayIndex: number): string {
  return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
}

function isBusinessDayIndex(dayIndex: number, holidays: Holidays): boolean {
  // 1970-01-01 was a Thursday; 0 = Sunday.
  const weekday = (((dayIndex + 4) % 7) + 7) % 7;
  return weekday >= 1 && weekday <= 5 && !holidays.has(dateKeyOf(dayIndex));
}

function nextBusinessDayIndex(fromIndex: number, holidays: Holidays): number {
  let index = fromIndex;
  for (let skipped = 0; skipped <= MAX_SKIPPED_DAYS; skipped += 1) {
    if (isBusinessDayIndex(index, holidays)) return index;
    index += 1;
  }
  throw new RangeError(`No business day within ${MAX_SKIPPED_DAYS} days of ${dateKeyOf(fromIndex)}; check ESCALATION_HOLIDAYS`);
}

/** Whether a Darwin calendar date (YYYY-MM-DD) is a business day. */
export function isBusinessDay(dateKey: string, holidays: Holidays = holidaysFromEnv()): boolean {
  if (!isRealDate(dateKey)) throw new RangeError(`Not a date: ${dateKey}`);
  const [year, month, day] = dateKey.split("-").map(Number);
  return isBusinessDayIndex(Date.UTC(year, month - 1, day) / DAY_MS, holidays);
}

/**
 * The instant `hours` of business time after `from`. A start outside business
 * hours counts from the next 08:30; a deadline that lands exactly on 16:30 stays
 * on that day. Zero hours returns `from` unchanged.
 */
export function addBusinessHours(from: Date, hours: number, holidays: Holidays = holidaysFromEnv()): Date {
  if (!Number.isFinite(hours) || hours < 0) throw new RangeError("hours must be a number of zero or more");
  if (hours === 0) return new Date(from.getTime());

  const startMs = BUSINESS_DAY_START_MINUTES * MINUTE_MS;
  const endMs = BUSINESS_DAY_END_MINUTES * MINUTE_MS;
  const local = from.getTime() + DARWIN_OFFSET_MS;
  let dayIndex = Math.floor(local / DAY_MS);
  let cursor = local - dayIndex * DAY_MS;
  let remaining = Math.round(hours * HOUR_MS);

  if (!isBusinessDayIndex(dayIndex, holidays)) {
    dayIndex = nextBusinessDayIndex(dayIndex + 1, holidays);
    cursor = startMs;
  } else if (cursor < startMs) {
    cursor = startMs;
  } else if (cursor >= endMs) {
    dayIndex = nextBusinessDayIndex(dayIndex + 1, holidays);
    cursor = startMs;
  }

  for (;;) {
    const available = endMs - cursor;
    if (remaining <= available) {
      return new Date(dayIndex * DAY_MS + cursor + remaining - DARWIN_OFFSET_MS);
    }
    remaining -= available;
    dayIndex = nextBusinessDayIndex(dayIndex + 1, holidays);
    cursor = startMs;
  }
}

/** The wall-clock variant (`clock = wall`): emergencies don't wait for morning. */
export function addWallHours(from: Date, hours: number): Date {
  if (!Number.isFinite(hours) || hours < 0) throw new RangeError("hours must be a number of zero or more");
  return new Date(from.getTime() + Math.round(hours * HOUR_MS));
}

export function addClockHours(
  clock: "business" | "wall",
  from: Date,
  hours: number,
  holidays: Holidays = holidaysFromEnv(),
): Date {
  return clock === "wall" ? addWallHours(from, hours) : addBusinessHours(from, hours, holidays);
}

/** Whether `hours` of business time have passed between `since` and `now`. */
export function businessHoursElapsed(
  since: Date,
  hours: number,
  now: Date,
  holidays: Holidays = holidaysFromEnv(),
): boolean {
  return addBusinessHours(since, hours, holidays).getTime() <= now.getTime();
}

/** Business hours in `days` business days (8 each, PLAN §3.7). */
export function businessDaysToHours(days: number): number {
  return days * BUSINESS_HOURS_PER_DAY;
}

/** The Darwin calendar day (YYYY-MM-DD) of an instant. */
export function darwinDateKey(instant: Date): string {
  return dateKeyOf(darwinDayIndex(instant));
}

// ── Calendar days and the business day's edges ───────────────────────────────
// Date-only helpers for schedules that are set by the day (the decision-request
// tiers): they work on YYYY-MM-DD Darwin dates and never on the process time zone.

function dayIndexOfKey(dateKey: string): number {
  if (!isRealDate(dateKey)) throw new RangeError(`Not a date: ${dateKey}`);
  const [year, month, day] = dateKey.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

/** Whether a string is a real YYYY-MM-DD calendar date. */
export function isDateKey(value: unknown): value is string {
  return typeof value === "string" && isRealDate(value);
}

/** The date `days` calendar days after `dateKey` (negative: before). */
export function addCalendarDays(dateKey: string, days: number): string {
  if (!Number.isInteger(days)) throw new RangeError("days must be a whole number");
  return dateKeyOf(dayIndexOfKey(dateKey) + days);
}

/** The first business day on or after `dateKey`. */
export function nextBusinessDay(dateKey: string, holidays: Holidays = holidaysFromEnv()): string {
  return dateKeyOf(nextBusinessDayIndex(dayIndexOfKey(dateKey), holidays));
}

/** The last business day on or before `dateKey`. */
export function previousBusinessDay(dateKey: string, holidays: Holidays = holidaysFromEnv()): string {
  let index = dayIndexOfKey(dateKey);
  for (let skipped = 0; skipped <= MAX_SKIPPED_DAYS; skipped += 1) {
    if (isBusinessDayIndex(index, holidays)) return dateKeyOf(index);
    index -= 1;
  }
  throw new RangeError(`No business day within ${MAX_SKIPPED_DAYS} days before ${dateKey}; check ESCALATION_HOLIDAYS`);
}

/** The business day `days` business days after `dateKey` (which need not be one
 *  itself): 1 is the next business day strictly after it. Zero returns `dateKey`. */
export function addBusinessDays(dateKey: string, days: number, holidays: Holidays = holidaysFromEnv()): string {
  if (!Number.isInteger(days) || days < 0) throw new RangeError("days must be a whole number of zero or more");
  let index = dayIndexOfKey(dateKey);
  for (let counted = 0; counted < days; counted += 1) {
    index = nextBusinessDayIndex(index + 1, holidays);
  }
  return dateKeyOf(index);
}

/** 08:30 Darwin on a date: when the business day opens. */
export function businessDayStart(dateKey: string): Date {
  return new Date(dayIndexOfKey(dateKey) * DAY_MS + BUSINESS_DAY_START_MINUTES * MINUTE_MS - DARWIN_OFFSET_MS);
}

/** 16:30 Darwin on a date: close of business. */
export function businessDayEnd(dateKey: string): Date {
  return new Date(dayIndexOfKey(dateKey) * DAY_MS + BUSINESS_DAY_END_MINUTES * MINUTE_MS - DARWIN_OFFSET_MS);
}

/**
 * The first moment at or after `instant` that falls inside business hours (08:30
 * up to, not including, 16:30 on a business day). An instant already inside is
 * returned as it is; one before opening waits for 08:30 that day, and one after
 * closing, at the weekend or on a holiday waits for 08:30 on the next business
 * day. For times people should be emailed, not left to arrive overnight.
 */
export function nextBusinessHoursInstant(instant: Date, holidays: Holidays = holidaysFromEnv()): Date {
  const startMs = BUSINESS_DAY_START_MINUTES * MINUTE_MS;
  const endMs = BUSINESS_DAY_END_MINUTES * MINUTE_MS;
  const local = instant.getTime() + DARWIN_OFFSET_MS;
  const dayIndex = Math.floor(local / DAY_MS);
  const cursor = local - dayIndex * DAY_MS;

  if (isBusinessDayIndex(dayIndex, holidays)) {
    if (cursor >= startMs && cursor < endMs) return new Date(instant.getTime());
    if (cursor < startMs) return new Date(dayIndex * DAY_MS + startMs - DARWIN_OFFSET_MS);
  }
  const next = nextBusinessDayIndex(dayIndex + 1, holidays);
  return new Date(next * DAY_MS + startMs - DARWIN_OFFSET_MS);
}

/** Minutes after midnight, Darwin, of an instant. */
export function darwinMinuteOfDay(instant: Date): number {
  const local = instant.getTime() + DARWIN_OFFSET_MS;
  return Math.floor((local - Math.floor(local / DAY_MS) * DAY_MS) / MINUTE_MS);
}
