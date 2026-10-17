// Lease events other than the rent review: the day a lease ends and the last
// day to give notice that an option is being exercised. Reviews have their own
// derivation (nextReviewDate.ts); this is the part getReviewsDue needs so a
// lease expiring in 45 days is not hidden behind a review that is a year away.

import { addDaysIso, addMonthsClamped, isIsoDate } from "./darwinDate";

export interface LeaseEventTenant {
  expiry?: string;
  optionNoticeMonths?: number;
}

/** How far ahead the dashboard and the Activity feed look. */
export const LEASE_EVENT_WINDOW_DAYS = 90;

/** Last day to give option notice: the expiry less the notice period, month-end safe. */
export function optionNoticeDate(tenant: LeaseEventTenant): string | undefined {
  if (!isIsoDate(tenant.expiry) || tenant.optionNoticeMonths == null) return undefined;
  return addMonthsClamped(tenant.expiry, -tenant.optionNoticeMonths);
}

function withinWindow(iso: string | undefined, today: string, windowDays: number): boolean {
  if (!isIsoDate(iso)) return false;
  return iso >= today && iso <= addDaysIso(today, windowDays);
}

/** True when the lease expires, or its option deadline falls, from `today` to `windowDays` ahead (Darwin dates). */
export function hasLeaseEventWithin(
  tenant: LeaseEventTenant,
  today: string,
  windowDays: number = LEASE_EVENT_WINDOW_DAYS,
): boolean {
  return (
    withinWindow(tenant.expiry, today, windowDays) ||
    withinWindow(optionNoticeDate(tenant), today, windowDays)
  );
}
