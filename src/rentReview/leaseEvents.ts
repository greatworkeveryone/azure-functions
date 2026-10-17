// The lease-events feed (PLAN WP25, F18c): what happens to leases in the next N
// days, for the dashboard's lease alerts and the Next 90 days list. Three kinds
// of row:
//
//   review           every open review whose date falls inside the window or has
//                    already passed (overdue)
//   expiry           the expiry of every active tenancy (not vacated, not archived),
//                    whether or not a review
//                    is due (F18c: expiries used to surface only with a review);
//                    a lease already past its expiry that hasn't been vacated is
//                    overdue
//   option_deadline the last day the tenant can give notice of an option, for
//                    the options optionNoticeWindow can date; one already
//                    passed isn't listed (WP32 handles a lapsed option)
//
// The rows hold names and dates and nothing else: no rent, ABN, contacts or
// notes (LAUNCH-READINESS §4.4: getReviewsDue sends whole tenancies to anyone
// signed in). Pure.

import { addDaysIso } from "../darwinDate";
import { optionNoticeWindow } from "../leaseOptions";
import { isOverdue, type RentReviewMethod, type RentReviewState } from "../rentReviewMachine";

export type LeaseEventKind = "expiry" | "option_deadline" | "review";

export interface LeaseEvent {
  buildingId: number;
  date: string;
  kind: LeaseEventKind;
  /** Review rows only. */
  method?: RentReviewMethod | null;
  overdue: boolean;
  ownerName?: string | null;
  ownerUserId?: number | null;
  reviewId?: string;
  state?: RentReviewState;
  tenantId: number;
  tenantName: string;
}

export interface LeaseEventTenancy {
  buildingId: number;
  expiry: string | null;
  optionNoticeMonths: number | null;
  optionPeriods: string | null;
  tenantId: number;
  tenantName: string;
}

export interface LeaseEventReview {
  buildingId: number;
  method: RentReviewMethod | null;
  ownerName: string | null;
  ownerUserId: number | null;
  reviewId: string;
  scheduledFor: string;
  state: RentReviewState;
  tenantId: number;
  tenantName: string;
}

const KIND_ORDER: Record<LeaseEventKind, number> = { review: 0, expiry: 1, option_deadline: 2 };

export const DEFAULT_LEASE_EVENT_DAYS = 90;
export const MAX_LEASE_EVENT_DAYS = 365;

export function buildLeaseEvents(input: {
  /** Whole days ahead to look; events further out are left off. */
  days: number;
  /** Open reviews only. */
  reviews: readonly LeaseEventReview[];
  /** Active (not vacated) tenancies. */
  tenancies: readonly LeaseEventTenancy[];
  /** The Darwin date. */
  today: string;
}): LeaseEvent[] {
  const { days, today } = input;
  const until = addDaysIso(today, days);
  const events: LeaseEvent[] = [];

  for (const review of input.reviews) {
    if (review.scheduledFor === "" || review.scheduledFor > until) continue;
    events.push({
      buildingId: review.buildingId,
      date: review.scheduledFor,
      kind: "review",
      method: review.method,
      overdue: isOverdue(review.state, review.scheduledFor, today),
      ownerName: review.ownerName,
      ownerUserId: review.ownerUserId,
      reviewId: review.reviewId,
      state: review.state,
      tenantId: review.tenantId,
      tenantName: review.tenantName,
    });
  }

  for (const tenancy of input.tenancies) {
    if (tenancy.expiry !== null && tenancy.expiry <= until) {
      events.push({
        buildingId: tenancy.buildingId,
        date: tenancy.expiry,
        kind: "expiry",
        overdue: tenancy.expiry < today,
        tenantId: tenancy.tenantId,
        tenantName: tenancy.tenantName,
      });
    }
    const window = optionNoticeWindow(tenancy, today);
    if (window.deadline !== null && window.state !== "closed" && window.deadline <= until) {
      events.push({
        buildingId: tenancy.buildingId,
        date: window.deadline,
        kind: "option_deadline",
        overdue: false,
        tenantId: tenancy.tenantId,
        tenantName: tenancy.tenantName,
      });
    }
  }

  return events.sort(
    (a, b) =>
      Number(b.overdue) - Number(a.overdue) ||
      a.date.localeCompare(b.date) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.tenantName.localeCompare(b.tenantName) ||
      a.tenantId - b.tenantId,
  );
}
