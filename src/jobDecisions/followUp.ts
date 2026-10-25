// How long what follows a decision is given (jobs plan A2): the next step it hands on,
// and the question that comes back when it is deferred. Both inherit the urgency the
// asker chose for the request (plan D5), counted from the day they begin rather than
// the day of the original ask. Pure: given the request, the moment and the holidays.
//
//   request tier   a next step, and a question asked again, get
//   soon           soon: a week from now
//   routine        routine: the same number of weeks from now
//   urgent         urgent: by tomorrow. A next step always moves up; a question
//                  asked again keeps the asker's tick (or not) from the request
//   fixed          the same date, if it is still a working day to come; if it has
//                  gone (the deadline passed while the question waited) urgent
//   emergency      urgent. An emergency is never chased, which is right for the
//                  moment of an emergency; the step or the question that follows it
//                  is ordinary work and is
//
// Whether it moves up to the owner's (or the asker's) manager when nobody acts is
// not the asker's choice here: a next step always does (nothing is left without an
// owner who is answerable), and a question asked again does as the original did,
// except that one that was an emergency, or whose deadline has gone, now does.

import { businessDayEnd, darwinDateKey, isBusinessDay, type Holidays } from "../escalation/businessTime";
import type { DecisionRequestRow } from "./store";
import { scheduleFor, type TierRequest, type TierSchedule } from "./tiers";

export type FollowUpPurpose = "next_step" | "reask";

type FollowUpRequest = Pick<DecisionRequestRow, "autoEscalate" | "respondBy" | "routineWeeks" | "tier">;

/** The tier a follow-up of this request is given. */
export function followUpTier(request: FollowUpRequest, purpose: FollowUpPurpose, now: Date, holidays: Holidays): TierRequest {
  const urgent = (autoEscalate: boolean): TierRequest => ({ autoEscalate, tier: "urgent" });

  switch (request.tier) {
    case "soon":
      return { tier: "soon" };
    case "routine":
      return request.routineWeeks === null ? { tier: "soon" } : { routineWeeks: request.routineWeeks, tier: "routine" };
    case "urgent":
      return urgent(purpose === "next_step" ? true : request.autoEscalate);
    case "fixed": {
      const date = request.respondBy ? darwinDateKey(request.respondBy) : null;
      if (date !== null && isBusinessDay(date, holidays) && businessDayEnd(date).getTime() > now.getTime()) {
        return { fixedDate: date, tier: "fixed" };
      }
      return urgent(true);
    }
    case "emergency":
      return urgent(true);
  }
}

/** When the follow-up is due, reminded and moved up: the schedule of its tier, from `now`. */
export function followUpSchedule(request: FollowUpRequest, purpose: FollowUpPurpose, now: Date, holidays: Holidays): TierSchedule {
  return scheduleFor(followUpTier(request, purpose, now, holidays), now, holidays);
}
