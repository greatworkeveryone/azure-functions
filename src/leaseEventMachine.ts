// Lease event state machine (PLAN §3.5 option exercise, §3.6 expiry and
// renewal, D13). Pure and side-effect free, with no imports, so the same file
// runs in both repos.
//
// KEEP IN SYNC: the frontend has a byte-identical copy at
// command-centre/src/types/leaseEventMachine.ts. Change both in the same
// package. The backend copy is the one that enforces; the frontend copy lets
// buttons explain themselves without a round trip.
//
// One dbo.LeaseEvents row is one lease event of one of two types. A missing
// event is `null`: OPEN_OPTION and REFER_RENEWAL are the only events that
// create one.
//
// option_exercise (§3.5):
//   window_not_open    the tenant's notice window hasn't opened yet
//   window_open        notice can be given (deadline − 6 months to the deadline;
//                      deadline = expiry − optionNoticeMonths)
//   notice_received    a notice dated outside the window was recorded: only a
//                      director may take it further (approve with a reason, or reject)
//   awaiting_approval  a notice dated inside the window was recorded; someone
//                      other than its recorder approves or a director rejects it
//   exercised          approved: the lease was extended (APPLY)
//   rejected           a director rejected the notice, with a reason
//   lapsed             the deadline passed with no notice
//
// renewal (§3.6):
//   referred           opened at ≤ 180 days to expiry with no option to
//                      exercise, and referred to the directors
//   renewed            a director recorded a new lease term
//   vacating           a director recorded that the tenant is leaving
//   holdover           a director recorded that the tenant holds over
//
// either type:
//   cancelled          closed by the system: the tenancy went, or another
//                      decision superseded the event (an option exercised
//                      late supersedes an open renewal)
//
// "Open" is the five states a decision is still owed in. A tenancy has at most
// one open event of each type (a filtered unique index enforces it). `lapsed`
// is not open: a late notice can still be recorded against it (RECORD_NOTICE),
// which opens it again as notice_received.
//
//   Event           Type      From                                    To                                Facts
//   OPEN_OPTION     option    (none)                                  window_open | window_not_open     windowOpen
//   OPEN_WINDOW     option    window_not_open                         window_open                       windowOpen
//   RECORD_NOTICE   option    window_not_open, window_open, lapsed    awaiting_approval | notice_received   noticeInWindow
//   APPROVE         option    awaiting_approval                       exercised
//                             notice_received                         exercised                         directorOverride
//   REJECT          option    notice_received, awaiting_approval      rejected
//   LAPSE           option    window_not_open, window_open            lapsed                            deadlinePassed
//   REFER_RENEWAL   renewal   (none)                                  referred
//   DECIDE_RENEWAL  renewal   referred                                renewed | vacating | holdover     outcome
//   CANCEL          either    any open                                cancelled
//
// A guard that needs a fact is strict: the caller must pass it, so a caller
// that forgets a fact is refused rather than let through. A fact that selects
// the target (windowOpen at OPEN_OPTION, noticeInWindow) defaults to the safe
// branch: the one that needs more people.

export const LEASE_EVENT_TYPES = ["option_exercise", "renewal"] as const;
export type LeaseEventType = (typeof LEASE_EVENT_TYPES)[number];

export const OPTION_EXERCISE_STATES = [
  "window_not_open",
  "window_open",
  "notice_received",
  "awaiting_approval",
  "exercised",
  "rejected",
  "lapsed",
] as const;

export const RENEWAL_STATES = ["referred", "renewed", "vacating", "holdover"] as const;

export const LEASE_EVENT_STATES = [...OPTION_EXERCISE_STATES, ...RENEWAL_STATES, "cancelled"] as const;
export type LeaseEventState = (typeof LEASE_EVENT_STATES)[number];

export const LEASE_EVENT_EVENTS = [
  "OPEN_OPTION",
  "OPEN_WINDOW",
  "RECORD_NOTICE",
  "APPROVE",
  "REJECT",
  "LAPSE",
  "REFER_RENEWAL",
  "DECIDE_RENEWAL",
  "CANCEL",
] as const;
export type LeaseEventEvent = (typeof LEASE_EVENT_EVENTS)[number];

export const RENEWAL_OUTCOMES = ["renewed", "vacating", "holdover"] as const;
export type RenewalOutcome = (typeof RENEWAL_OUTCOMES)[number];

/** The states a decision is still owed in. */
export const OPEN_LEASE_EVENT_STATES: readonly LeaseEventState[] = [
  "window_not_open",
  "window_open",
  "notice_received",
  "awaiting_approval",
  "referred",
];

export interface LeaseEventFacts {
  /** LAPSE: today (Darwin) is after the notice deadline. */
  deadlinePassed?: boolean;
  /** APPROVE from notice_received: a director overrides the window (C10) with a reason. */
  directorOverride?: boolean;
  /** RECORD_NOTICE: the notice is dated inside the window (both ends included). */
  noticeInWindow?: boolean;
  /** DECIDE_RENEWAL: what the director decided. */
  outcome?: RenewalOutcome;
  /** OPEN_OPTION, OPEN_WINDOW: today (Darwin) is on or after the day the window opens. */
  windowOpen?: boolean;
}

export function isOpenLeaseEventState(state: LeaseEventState): boolean {
  return OPEN_LEASE_EVENT_STATES.includes(state);
}

/** The type a state belongs to; null for `cancelled`, which both share. */
export function typeOfState(state: LeaseEventState): LeaseEventType | null {
  if ((OPTION_EXERCISE_STATES as readonly string[]).includes(state)) return "option_exercise";
  if ((RENEWAL_STATES as readonly string[]).includes(state)) return "renewal";
  return null;
}

interface Rule {
  from: readonly (LeaseEventState | null)[];
  guard?: (facts: LeaseEventFacts) => boolean;
  to: LeaseEventState | ((facts: LeaseEventFacts) => LeaseEventState | null);
  type: LeaseEventType | "either";
}

const RULES: Record<LeaseEventEvent, Rule> = {
  OPEN_OPTION: {
    from: [null],
    to: (facts) => (facts.windowOpen === true ? "window_open" : "window_not_open"),
    type: "option_exercise",
  },
  OPEN_WINDOW: { from: ["window_not_open"], guard: (facts) => facts.windowOpen === true, to: "window_open", type: "option_exercise" },
  RECORD_NOTICE: {
    from: ["window_not_open", "window_open", "lapsed"],
    to: (facts) => (facts.noticeInWindow === true ? "awaiting_approval" : "notice_received"),
    type: "option_exercise",
  },
  APPROVE: {
    from: ["awaiting_approval", "notice_received"],
    to: (facts) => (facts.directorOverride === true ? "exercised" : null),
    type: "option_exercise",
  },
  REJECT: { from: ["notice_received", "awaiting_approval"], to: "rejected", type: "option_exercise" },
  LAPSE: { from: ["window_not_open", "window_open"], guard: (facts) => facts.deadlinePassed === true, to: "lapsed", type: "option_exercise" },
  REFER_RENEWAL: { from: [null], to: "referred", type: "renewal" },
  DECIDE_RENEWAL: {
    from: ["referred"],
    to: (facts) => (facts.outcome && (RENEWAL_OUTCOMES as readonly string[]).includes(facts.outcome) ? facts.outcome : null),
    type: "renewal",
  },
  CANCEL: { from: OPEN_LEASE_EVENT_STATES, to: "cancelled", type: "either" },
};

/** Where `event` takes an event of `type` in `state` (`null` for no event yet),
 *  or null when the event is not legal there. */
export function nextLeaseEventState(
  type: LeaseEventType,
  state: LeaseEventState | null,
  event: LeaseEventEvent,
  facts: LeaseEventFacts = {},
): LeaseEventState | null {
  // An event name can arrive from a request body; "constructor" is not a rule.
  const rule = Object.prototype.hasOwnProperty.call(RULES, event) ? RULES[event] : undefined;
  if (!rule || (rule.type !== "either" && rule.type !== type)) return null;
  if (state !== null && typeOfState(state) !== null && typeOfState(state) !== type) return null;
  if (!rule.from.includes(state)) return null;
  if (rule.guard && !rule.guard(facts)) return null;
  // APPROVE from awaiting_approval needs no override; from notice_received it does.
  if (event === "APPROVE" && state === "awaiting_approval") return "exercised";
  return typeof rule.to === "function" ? rule.to(facts) : rule.to;
}

export function canLeaseEventTransition(
  type: LeaseEventType,
  state: LeaseEventState | null,
  event: LeaseEventEvent,
  facts: LeaseEventFacts = {},
): boolean {
  return nextLeaseEventState(type, state, event, facts) !== null;
}
