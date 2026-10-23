// Australian financial years for the Maintenance spend report: 1 July to 30 June,
// counted on the Darwin calendar (a fixed UTC+09:30, no daylight saving). A year is
// named the way staff say it: "2025-26" runs 1 July 2025 to 30 June 2026.

import { addDaysIso, todayInDarwin } from "../darwinDate";

export interface FinancialYear {
  /** First day, "YYYY-MM-DD" (1 July). */
  from: string;
  label: string;
  /** The calendar year it starts in. */
  startYear: number;
  /** Last day, "YYYY-MM-DD" (30 June). */
  to: string;
}

const LABEL = /^(\d{4})-(\d{2})$/;
const FIRST_START_YEAR = 2000;

export function financialYear(startYear: number): FinancialYear {
  const end = startYear + 1;
  return { from: `${startYear}-07-01`, label: `${startYear}-${String(end % 100).padStart(2, "0")}`, startYear, to: `${end}-06-30` };
}

/** The financial year a Darwin calendar date ("YYYY-MM-DD") falls in. */
export function financialYearOf(darwinDate: string): FinancialYear {
  const year = Number(darwinDate.slice(0, 4));
  const month = Number(darwinDate.slice(5, 7));
  return financialYear(month >= 7 ? year : year - 1);
}

/**
 * The year the request names, or the current one (Darwin) when it names none.
 * One year ahead is allowed so a clock a few seconds fast at midnight on 1 July
 * doesn't get a 400; there is nothing in it, so it reports nothing.
 */
export function parseFinancialYear(raw: string | null | undefined, today: string): FinancialYear | { error: string } {
  const current = financialYearOf(today);
  const text = raw?.trim() ?? "";
  if (text === "") return current;
  const parts = text.match(LABEL);
  const start = parts ? Number(parts[1]) : Number.NaN;
  if (!parts || Number(parts[2]) !== (start + 1) % 100) {
    return { error: "financialYear must look like 2025-26: the year from 1 July 2025 to 30 June 2026" };
  }
  if (start < FIRST_START_YEAR || start > current.startYear + 1) {
    return { error: `financialYear must be from ${financialYear(FIRST_START_YEAR).label} to ${financialYear(current.startYear + 1).label}` };
  }
  return financialYear(start);
}

/** Whether an instant falls in the year, read on the Darwin calendar. */
export function isInFinancialYear(instant: Date, year: FinancialYear): boolean {
  const date = todayInDarwin(instant);
  return date >= year.from && date <= year.to;
}

/**
 * UTC instants that bracket the year with a day to spare on the front and two on
 * the back, for the SQL read. The exact edge is decided per invoice, in Darwin
 * time, by isInFinancialYear, so a read can never leave out an invoice that
 * belongs (Darwin midnight is 14:30 UTC the day before).
 */
export function queryWindow(year: FinancialYear): { from: Date; to: Date } {
  return { from: new Date(`${addDaysIso(year.from, -1)}T00:00:00Z`), to: new Date(`${addDaysIso(year.to, 2)}T00:00:00Z`) };
}
