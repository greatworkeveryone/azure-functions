// Rent review state machine (PLAN §3.1, D2). Pure and side-effect free, with no
// imports, so the same file runs in both repos.
//
// KEEP IN SYNC: the frontend has a byte-identical copy at
// command-centre/src/helpers/rentReviewMachine.ts. Change both in the same
// package; the exhaustive transition test is the same file on both sides.
// The backend copy is the one that enforces; the frontend copy lets buttons
// explain themselves without a round trip.
//
// A review instance moves through ten states. A missing instance is `null`:
// SCHEDULE is the only event that creates one.
//
//   scheduled          generated for the tenancy's next review date
//   due                inside the review window (REVIEW_WINDOW_DAYS before the date)
//   in_progress        commenced: someone owns it and the basis is snapshotted
//   awaiting_index     CPI review waiting for the reference quarter to be published
//   referred           market review handed to the directors (an offline process)
//   awaiting_approval  submitted; needs someone else's approval
//   approved           applied to the schedule; notice and billing still to close out
//   completed          closed out
//   waived             no change to the rent, decided with a reason
//   cancelled          withdrawn (tenancy vacated, superseded), decided with a reason
//
// "Open" means the six states before `approved`. A tenancy has at most one open
// review (a unique index enforces it), a review is overdue only while open, and
// "any pre-approval" in the PLAN's table means the same six states.
//
// Overdue is derived, never stored: see isOverdue.
//
// What lives here and what does not. The machine says which event is legal from
// which state, where it lands, and the guards that are pure facts about the
// review itself (is the review window open, is it a market review, are notice
// and billing done). It does not know who is asking or what the schedule holds:
// capabilities, separation of duties, the sanity band and the C1-C10 checks are
// the server's. A guard that needs a fact is strict: the caller must pass it
// as true, so a caller that forgets a fact is refused rather than let through.
// A fact that selects the target (autoApprove, recordedByDirector) defaults to
// the safe branch: awaiting_approval.
//
//   Event             From                         To                         Facts
//   SCHEDULE          (none)                       scheduled
//   OPEN_WINDOW       scheduled                    due                        withinWindow
//   COMMENCE          scheduled, due               in_progress
//   INDEX_PENDING     in_progress                  awaiting_index             method = cpi
//   INDEX_AVAILABLE   awaiting_index               in_progress
//   REFER             in_progress                  referred                   method = market
//   RECORD_MILESTONE  referred                     referred
//   RECORD_OUTCOME    referred                     approved | awaiting_approval   recordedByDirector
//   SUBMIT            in_progress                  approved | awaiting_approval   autoApprove
//   APPROVE           awaiting_approval            approved
//   RETURN            awaiting_approval            in_progress
//   WAIVE             any open                     waived
//   CANCEL            any open                     cancelled
//   ISSUE_NOTICE      approved                     approved
//   CONFIRM_BILLING   approved                     approved
//   CLOSE             approved                     completed                  noticeHandled, billingConfirmed
//   REVERT            approved                     in_progress

export const RENT_REVIEW_STATES = [
  "scheduled",
  "due",
  "in_progress",
  "awaiting_index",
  "referred",
  "awaiting_approval",
  "approved",
  "completed",
  "waived",
  "cancelled",
] as const;

export type RentReviewState = (typeof RENT_REVIEW_STATES)[number];

export const RENT_REVIEW_EVENTS = [
  "SCHEDULE",
  "OPEN_WINDOW",
  "COMMENCE",
  "INDEX_PENDING",
  "INDEX_AVAILABLE",
  "REFER",
  "RECORD_MILESTONE",
  "RECORD_OUTCOME",
  "SUBMIT",
  "APPROVE",
  "RETURN",
  "WAIVE",
  "CANCEL",
  "ISSUE_NOTICE",
  "CONFIRM_BILLING",
  "CLOSE",
  "REVERT",
] as const;

export type RentReviewEvent = (typeof RENT_REVIEW_EVENTS)[number];

export type RentReviewMethod = "cpi" | "fixed" | "market" | "other";

/** Facts the caller has verified about the review. See the header for which
 *  event reads which. */
export interface RentReviewFacts {
  /** SUBMIT: the calculated result is inside the sanity band and carries no
   *  override (rule auto_in_bounds), so submitting applies it. */
  autoApprove?: boolean;
  /** CLOSE: billing is confirmed. */
  billingConfirmed?: boolean;
  /** INDEX_PENDING and REFER: the review's method. */
  method?: RentReviewMethod;
  /** CLOSE: the notice is issued, or recorded as not required with a reason. */
  noticeHandled?: boolean;
  /** RECORD_OUTCOME: a director is recording the outcome (the director path applies it). */
  recordedByDirector?: boolean;
  /** OPEN_WINDOW: scheduledFor minus today is at most REVIEW_WINDOW_DAYS. */
  withinWindow?: boolean;
}

/** The six states a review can still be decided in. */
export const OPEN_RENT_REVIEW_STATES: readonly RentReviewState[] = [
  "scheduled",
  "due",
  "in_progress",
  "awaiting_index",
  "referred",
  "awaiting_approval",
];

export function isOpenState(state: RentReviewState): boolean {
  return OPEN_RENT_REVIEW_STATES.includes(state);
}

/**
 * Overdue is derived, not a state: the review's date has passed (Darwin) while
 * it is still open. `scheduledFor` and `todayDarwin` are ISO "YYYY-MM-DD"
 * strings, compared as text.
 */
export function isOverdue(state: RentReviewState, scheduledFor: string, todayDarwin: string): boolean {
  return isOpenState(state) && scheduledFor < todayDarwin;
}

interface Rule {
  /** `null` stands for "no instance yet". */
  from: readonly (RentReviewState | null)[];
  guard?: (facts: RentReviewFacts) => boolean;
  to: RentReviewState | ((facts: RentReviewFacts) => RentReviewState);
}

const RULES: Record<RentReviewEvent, Rule> = {
  SCHEDULE: { from: [null], to: "scheduled" },
  OPEN_WINDOW: { from: ["scheduled"], guard: (facts) => facts.withinWindow === true, to: "due" },
  COMMENCE: { from: ["scheduled", "due"], to: "in_progress" },
  INDEX_PENDING: { from: ["in_progress"], guard: (facts) => facts.method === "cpi", to: "awaiting_index" },
  INDEX_AVAILABLE: { from: ["awaiting_index"], to: "in_progress" },
  REFER: { from: ["in_progress"], guard: (facts) => facts.method === "market", to: "referred" },
  RECORD_MILESTONE: { from: ["referred"], to: "referred" },
  RECORD_OUTCOME: {
    from: ["referred"],
    to: (facts) => (facts.recordedByDirector === true ? "approved" : "awaiting_approval"),
  },
  SUBMIT: {
    from: ["in_progress"],
    to: (facts) => (facts.autoApprove === true ? "approved" : "awaiting_approval"),
  },
  APPROVE: { from: ["awaiting_approval"], to: "approved" },
  RETURN: { from: ["awaiting_approval"], to: "in_progress" },
  WAIVE: { from: OPEN_RENT_REVIEW_STATES, to: "waived" },
  CANCEL: { from: OPEN_RENT_REVIEW_STATES, to: "cancelled" },
  ISSUE_NOTICE: { from: ["approved"], to: "approved" },
  CONFIRM_BILLING: { from: ["approved"], to: "approved" },
  CLOSE: {
    from: ["approved"],
    guard: (facts) => facts.noticeHandled === true && facts.billingConfirmed === true,
    to: "completed",
  },
  REVERT: { from: ["approved"], to: "in_progress" },
};

/** Where `event` takes a review in `state` (`null` for no instance yet), or
 *  null when the event is not legal there. */
export function nextState(
  state: RentReviewState | null,
  event: RentReviewEvent,
  facts: RentReviewFacts = {},
): RentReviewState | null {
  // An event name can arrive from a request body; "constructor" is not a rule.
  const rule = Object.prototype.hasOwnProperty.call(RULES, event) ? RULES[event] : undefined;
  if (!rule || !rule.from.includes(state)) return null;
  if (rule.guard && !rule.guard(facts)) return null;
  return typeof rule.to === "function" ? rule.to(facts) : rule.to;
}

export function canTransition(
  state: RentReviewState | null,
  event: RentReviewEvent,
  facts: RentReviewFacts = {},
): boolean {
  return nextState(state, event, facts) !== null;
}
