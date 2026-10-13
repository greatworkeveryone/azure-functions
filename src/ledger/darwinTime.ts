// Darwin is UTC+09:30 all year (ACST, no daylight saving). The Function host
// runs UTC and the ledger stores UTC, so every Darwin calendar boundary is plain
// arithmetic on that fixed offset. Never use Date's local getters or process
// TZ here: the same code must give the same answer on a laptop in Copenhagen.
const DARWIN_OFFSET_MS = 9.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CalendarDate {
  day: number;
  month: number; // 1-12
  year: number;
}

/** Strict YYYY-MM-DD (a real calendar date), else null. */
export function parseDarwinDate(value: string): CalendarDate | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return { day, month, year };
}

/** The UTC instant at which this Darwin calendar day begins (00:00 +09:30). */
export function darwinDayStartUtc(date: CalendarDate): Date {
  return new Date(Date.UTC(date.year, date.month - 1, date.day) - DARWIN_OFFSET_MS);
}

/** The UTC instant at which the NEXT Darwin day begins: an exclusive upper bound
 *  that makes a `to` date inclusive of its whole day. */
export function darwinNextDayStartUtc(date: CalendarDate): Date {
  return new Date(darwinDayStartUtc(date).getTime() + DAY_MS);
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** The wall clock in Darwin for a UTC instant, via the UTC getters of the shifted time. */
function darwinParts(instant: Date) {
  const shifted = new Date(instant.getTime() + DARWIN_OFFSET_MS);
  return {
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    month: shifted.getUTCMonth() + 1,
    year: shifted.getUTCFullYear(),
  };
}

/** DD/MM/YYYY HH:mm in Darwin time, 24-hour. Day first, always (R6). */
export function formatDarwinDateTime(instant: Date): string {
  const p = darwinParts(instant);
  return `${pad(p.day)}/${pad(p.month)}/${pad(p.year, 4)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** YYYYMMDD for file names, by the Darwin calendar. */
export function darwinFileDate(instant: Date): string {
  const p = darwinParts(instant);
  return `${pad(p.year, 4)}${pad(p.month)}${pad(p.day)}`;
}
