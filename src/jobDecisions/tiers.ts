// Urgency tiers for a decision request (plan D5: "who is it for, and how long are
// you giving them?"). One pure module: given a tier, the raiser's choice of weeks
// or date, and the moment of asking, it says when the answer is due, when the
// people asked are reminded and when the request moves up to the raiser's manager.
// No I/O and never the process time zone; the same answer on a laptop in Copenhagen.
//
// Everything is on the Darwin business calendar of the escalation engine
// (escalation/businessTime.ts): Monday to Friday, 08:30 to 16:30, less the public
// holidays in ESCALATION_HOLIDAYS. Nothing is scheduled for a weekend, a holiday or
// the middle of the night. A deadline is close of business (16:30) on a business
// day, a reminder set by the day goes out when that day opens (08:30), and an
// escalation comes at the deadline or on the next business morning.
//
//   tier       respond by                  reminders                          moves up
//   emergency  none                        none                               never: Floorplan records it
//   urgent     close of business on the    24 hours after the request, if     only if the raiser ticks
//              next business day           that is inside business hours on   auto-escalate (off unless
//              ("by tomorrow")             the due day, else when it opens    ticked): the next business
//                                                                             morning after the respond-by
//                                                                             (the 36-hour mark, usually)
//   soon       a week after the request    the business day before            at the respond-by
//   routine    2 to 8 weeks after          a week before                      at the respond-by
//   fixed      the date given              4, 2 and 1 days before, and        at the respond-by
//                                          on the day
//
// "Moves up" is the escalation engine's own step: the ladder is the people asked,
// then the raiser's manager, then a director. Soon, routine and fixed always move
// up; urgent does only when `autoEscalate` is true (the reminder at 24 hours goes
// either way); emergency never does. A date that lands on a weekend or a
// public holiday moves to the next business day when it is a deadline, and back to
// the business day before when it is a reminder, so a reminder is never later than
// the day it was meant for; two reminders that land on the same day become one.

import {
  addCalendarDays,
  businessDayEnd,
  businessDayStart,
  darwinDateKey,
  holidaysFromEnv,
  isBusinessDay,
  isDateKey,
  nextBusinessDay,
  nextBusinessHoursInstant,
  previousBusinessDay,
  type Holidays,
} from "../escalation/businessTime";

export const DECISION_TIERS = ["emergency", "urgent", "soon", "routine", "fixed"] as const;
export type DecisionTier = (typeof DECISION_TIERS)[number];

export const ROUTINE_WEEKS_MIN = 2;
export const ROUTINE_WEEKS_MAX = 8;
/** A fixed deadline further out than this is a typo for another year. */
export const FIXED_MAX_DAYS_AHEAD = 366;

const HOUR_MS = 3_600_000;
/** Urgent: the one reminder comes 24 hours after the request. */
export const URGENT_REMIND_AFTER_HOURS = 24;
/** Urgent: the escalation is 12 hours after close of business on the respond-by
 *  day, then on to the next business hour: the next business morning. When the
 *  request was made in business hours that is the 36-hour mark. */
export const URGENT_ESCALATE_GRACE_HOURS = 12;
/** Soon is a week; a routine request is this many days to the week. */
export const DAYS_PER_WEEK = 7;
/** Fixed: reminders this many days before the date, and on the day. */
export const FIXED_REMINDER_DAYS_BEFORE = [4, 2, 1] as const;

export type TierErrorCode =
  | "auto_escalate_invalid"
  | "auto_escalate_not_optional"
  | "fixed_date_invalid"
  | "fixed_date_not_a_working_day"
  | "fixed_date_past"
  | "fixed_date_required"
  | "fixed_date_too_far"
  | "invalid_tier"
  | "routine_weeks_invalid"
  | "routine_weeks_required"
  | "unexpected_fixed_date"
  | "unexpected_routine_weeks";

/** What the person asking got wrong. `status` is the HTTP answer: 400 for a
 *  missing or malformed value, 422 for a well-formed one the rules refuse. */
export class TierError extends Error {
  readonly code: TierErrorCode;
  readonly status: 400 | 422;

  constructor(code: TierErrorCode, message: string, status: 400 | 422 = 400) {
    super(message);
    this.name = "TierError";
    this.code = code;
    this.status = status;
  }
}

/** The raiser's choice, as the endpoint reads it. */
export interface TierRequest {
  /** Urgent only: move up to the raiser's manager if still unanswered at the 36-hour
   *  mark. Off unless true. Soon, routine and fixed always move up (and refuse
   *  false); an emergency never does (and ignores this). */
  autoEscalate?: boolean;
  /** A Darwin date, YYYY-MM-DD. Fixed only. */
  fixedDate?: string | null;
  /** Whole weeks, 2 to 8. Routine only. */
  routineWeeks?: number | null;
  tier: DecisionTier;
}

export interface TierSchedule {
  /** Whether the request moves up to the raiser's manager on its own when it is
   *  unanswered: always for soon, routine and fixed; for urgent only when asked;
   *  never for an emergency. */
  autoEscalate: boolean;
  /** Emergency: the screen says "call them"; Floorplan records and does not chase. */
  callThem: boolean;
  /** The Darwin date the respond-by falls on, or null with no deadline. */
  dueDate: string | null;
  /** When the request moves up if it is still unanswered; null = never (an emergency,
   *  or an urgent request not ticked to move up). */
  escalateAt: Date | null;
  /** The date given, for a fixed deadline. */
  fixedDate: string | null;
  /** Each a business-hours instant after `now` and before `escalateAt`, ascending. */
  remindAt: Date[];
  /** When an answer is due; null = no deadline (emergency). */
  respondBy: Date | null;
  routineWeeks: number | null;
  tier: DecisionTier;
  /** False only for emergency: nothing is chased. */
  timed: boolean;
  /** The escalation is raised as urgent: it sorts first and its emails say so. */
  urgent: boolean;
}

export function isDecisionTier(value: unknown): value is DecisionTier {
  return typeof value === "string" && (DECISION_TIERS as readonly string[]).includes(value);
}

function isRoutineWeeks(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= ROUTINE_WEEKS_MIN && value <= ROUTINE_WEEKS_MAX;
}

const weeksRule = `routineWeeks must be a whole number from ${ROUTINE_WEEKS_MIN} to ${ROUTINE_WEEKS_MAX}`;

/** soon, routine and fixed always move up: only an urgent request can opt out. */
function refuseOptOut(tier: DecisionTier, autoEscalate: boolean | undefined): void {
  if (autoEscalate === false) {
    throw new TierError(
      "auto_escalate_not_optional",
      `A ${tier} request always moves up to the raiser's manager when it isn't answered in time. Only an urgent one can opt out (autoEscalate).`,
    );
  }
}

/**
 * The raiser's raw choice -> a typed TierRequest, or a TierError. Each tier takes
 * only its own extra: weeks for routine, a date for fixed, a tick (autoEscalate) for
 * urgent. Anything else sent with it is refused rather than ignored, so a front end
 * that sends the wrong thing finds out. The one exception is autoEscalate, which
 * only has to be true or false: soon, routine and fixed accept true (they always move
 * up) and refuse false; an emergency, which is never chased, ignores it.
 */
export function parseTierRequest(raw: { autoEscalate?: unknown; fixedDate?: unknown; routineWeeks?: unknown; tier?: unknown }): TierRequest {
  if (!isDecisionTier(raw.tier)) {
    throw new TierError("invalid_tier", `tier must be one of ${DECISION_TIERS.join(", ")}`);
  }
  const tier = raw.tier;
  const hasWeeks = raw.routineWeeks !== undefined && raw.routineWeeks !== null;
  const hasDate = raw.fixedDate !== undefined && raw.fixedDate !== null && raw.fixedDate !== "";
  if (raw.autoEscalate !== undefined && raw.autoEscalate !== null && typeof raw.autoEscalate !== "boolean") {
    throw new TierError("auto_escalate_invalid", "autoEscalate must be true or false");
  }
  const autoEscalate = typeof raw.autoEscalate === "boolean" ? raw.autoEscalate : undefined;

  if (tier === "routine") {
    if (hasDate) throw new TierError("unexpected_fixed_date", "A routine request takes a number of weeks, not a date");
    if (!hasWeeks) throw new TierError("routine_weeks_required", `Say how many weeks to give them, from ${ROUTINE_WEEKS_MIN} to ${ROUTINE_WEEKS_MAX}`);
    if (!isRoutineWeeks(raw.routineWeeks)) throw new TierError("routine_weeks_invalid", weeksRule);
    refuseOptOut(tier, autoEscalate);
    return { routineWeeks: raw.routineWeeks, tier };
  }

  if (tier === "fixed") {
    if (hasWeeks) throw new TierError("unexpected_routine_weeks", "A fixed-deadline request takes a date, not a number of weeks");
    if (!hasDate) throw new TierError("fixed_date_required", "Say which date the decision is needed by (fixedDate, YYYY-MM-DD)");
    if (!isDateKey(raw.fixedDate)) throw new TierError("fixed_date_invalid", "fixedDate must be a real date written YYYY-MM-DD");
    refuseOptOut(tier, autoEscalate);
    return { fixedDate: raw.fixedDate, tier };
  }

  if (hasWeeks) throw new TierError("unexpected_routine_weeks", `routineWeeks only goes with the routine tier, not ${tier}`);
  if (hasDate) throw new TierError("unexpected_fixed_date", `fixedDate only goes with the fixed tier, not ${tier}`);
  if (tier === "urgent") return autoEscalate === undefined ? { tier } : { autoEscalate, tier };
  if (tier === "soon") refuseOptOut(tier, autoEscalate);
  return { tier };
}

const afterHours = (instant: Date, hours: number): Date => new Date(instant.getTime() + hours * HOUR_MS);

/** A timed schedule: the deadline is close of business on `dueDate`, the reminders
 *  are the given instants (ascending, de-duplicated, none already past) and the
 *  request moves up at `escalateAt`: by default the deadline itself, never when null. */
function timedSchedule(
  request: TierRequest,
  now: Date,
  plan: { dueDate: string; escalateAt?: Date | null; remindAt: Date[]; urgent?: boolean },
): TierSchedule {
  const respondBy = businessDayEnd(plan.dueDate);
  const remindAt = [...new Set(plan.remindAt.map((instant) => instant.getTime()))]
    .sort((a, b) => a - b)
    .filter((time) => time > now.getTime())
    .map((time) => new Date(time));
  const escalateAt = plan.escalateAt === undefined ? respondBy : plan.escalateAt;
  return {
    autoEscalate: escalateAt !== null,
    callThem: false,
    dueDate: plan.dueDate,
    escalateAt,
    fixedDate: request.tier === "fixed" ? plan.dueDate : null,
    remindAt,
    respondBy,
    routineWeeks: request.tier === "routine" ? (request.routineWeeks ?? null) : null,
    tier: request.tier,
    timed: true,
    urgent: plan.urgent ?? false,
  };
}

/** The mornings the given dates open, as reminder instants. */
const morningsOf = (dates: string[]): Date[] => dates.map((date) => businessDayStart(date));

/**
 * When a request of this tier, asked at `now`, is due, reminded and moved up.
 * Throws TierError when a routine request's weeks are out of range, a fixed date is
 * in the past, not a working day or too far out, or a soon, routine or fixed request
 * is told not to move up (the parse refuses that too; this is the rule itself). Pure:
 * pass `holidays` to fix the calendar, as the tests do.
 */
export function scheduleFor(request: TierRequest, now: Date, holidays: Holidays = holidaysFromEnv()): TierSchedule {
  const today = darwinDateKey(now);
  if (request.tier === "soon" || request.tier === "routine" || request.tier === "fixed") refuseOptOut(request.tier, request.autoEscalate);

  switch (request.tier) {
    case "emergency":
      return {
        autoEscalate: false,
        callThem: true,
        dueDate: null,
        escalateAt: null,
        fixedDate: null,
        remindAt: [],
        respondBy: null,
        routineWeeks: null,
        tier: "emergency",
        timed: false,
        urgent: true,
      };

    case "urgent": {
      // "By tomorrow": close of business on the next business day. The reminder is
      // the 24-hour mark when that falls inside business hours on that day, and
      // otherwise (asked at night, at the weekend, or the day is further out) the
      // morning it opens.
      const dueDate = nextBusinessDay(addCalendarDays(today, 1), holidays);
      const opens = businessDayStart(dueDate);
      const closes = businessDayEnd(dueDate);
      const mark = afterHours(now, URGENT_REMIND_AFTER_HOURS);
      const remindAt = mark.getTime() >= opens.getTime() && mark.getTime() < closes.getTime() ? mark : opens;
      // Moving up is the raiser's tick, off unless they asked for it (D5): the
      // reminder goes either way.
      const escalateAt = request.autoEscalate === true ? nextBusinessHoursInstant(afterHours(closes, URGENT_ESCALATE_GRACE_HOURS), holidays) : null;
      return timedSchedule(request, now, { dueDate, escalateAt, remindAt: [remindAt], urgent: true });
    }

    case "soon": {
      const dueDate = nextBusinessDay(addCalendarDays(today, DAYS_PER_WEEK), holidays);
      const remindDate = previousBusinessDay(addCalendarDays(dueDate, -1), holidays);
      return timedSchedule(request, now, { dueDate, remindAt: morningsOf([remindDate]) });
    }

    case "routine": {
      if (!isRoutineWeeks(request.routineWeeks)) throw new TierError("routine_weeks_invalid", weeksRule);
      const dueDate = nextBusinessDay(addCalendarDays(today, DAYS_PER_WEEK * request.routineWeeks), holidays);
      const remindDate = previousBusinessDay(addCalendarDays(dueDate, -DAYS_PER_WEEK), holidays);
      return timedSchedule(request, now, { dueDate, remindAt: morningsOf([remindDate]) });
    }

    case "fixed": {
      const date = request.fixedDate;
      if (!isDateKey(date)) throw new TierError("fixed_date_invalid", "fixedDate must be a real date written YYYY-MM-DD");
      if (!isBusinessDay(date, holidays)) {
        throw new TierError(
          "fixed_date_not_a_working_day",
          "That date is a weekend or a public holiday in Darwin. Pick the working day the decision is needed by.",
          422,
        );
      }
      if (businessDayEnd(date).getTime() <= now.getTime()) {
        throw new TierError("fixed_date_past", "That date has already passed. Pick today or a later date.", 422);
      }
      if (date > addCalendarDays(today, FIXED_MAX_DAYS_AHEAD)) {
        throw new TierError("fixed_date_too_far", `Pick a date within the next ${FIXED_MAX_DAYS_AHEAD} days.`, 422);
      }
      const before = FIXED_REMINDER_DAYS_BEFORE.map((days) => previousBusinessDay(addCalendarDays(date, -days), holidays));
      return timedSchedule(request, now, { dueDate: date, remindAt: morningsOf([...before, date]) });
    }
  }
}
