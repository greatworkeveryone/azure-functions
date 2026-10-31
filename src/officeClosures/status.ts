// Is the office open, and if not, when does it reopen. Pure: the calendar is passed in.
// Office hours (Mon-Fri 08:30-16:30 Darwin) live in escalation/businessTime.ts; closures are whole Darwin days.

import { BUSINESS_DAY_START_MINUTES, businessDayEnd, darwinDateKey, darwinMinuteOfDay, isBusinessDay, nextBusinessHoursInstant, type Holidays } from "../escalation/businessTime";

export interface ClosureSpan {
  endsOn: string;
  label: string;
  startsOn: string;
}

/** Closure days (for the business-time engine) plus the closures themselves (for labels). */
export interface OfficeCalendar {
  closures: ClosureSpan[];
  holidays: Holidays;
}

export interface OfficeStatus {
  closureLabel: string | null;
  open: boolean;
  reopensAt: string | null;
}

export function officeStatus(now: Date, calendar: OfficeCalendar): OfficeStatus {
  const today = darwinDateKey(now);
  const closing = darwinDateKey(businessDayEnd(today));
  const minute = darwinMinuteOfDay(now);
  const endMinute = darwinMinuteOfDay(businessDayEnd(today));
  const inHours = isBusinessDay(today, calendar.holidays) && closing === today && minute >= BUSINESS_DAY_START_MINUTES && minute < endMinute;
  if (inHours) return { closureLabel: null, open: true, reopensAt: null };
  const closure = calendar.closures.find((c) => c.startsOn <= today && today <= c.endsOn);
  return { closureLabel: closure?.label ?? null, open: false, reopensAt: nextBusinessHoursInstant(now, calendar.holidays).toISOString() };
}
