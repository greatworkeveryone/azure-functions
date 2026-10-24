// Who is away today, and why. Pure: dates are Darwin calendar dates ("YYYY-MM-DD"),
// the clock and the holiday calendar come in as arguments.
//
//   planned     approved leave covering today, approved BEFORE its start date
//   unplanned   approved leave covering today that was approved on or after its
//               start date: sick or personal leave booked on the day or after,
//               or any leave nobody knew about in advance
//   inactive    no sign-in for ABSENCE_INACTIVITY_DAYS completed business days,
//               while not on leave. Only when access logging is on; and only for
//               someone the log has seen at least once (nobody is called away
//               because the log never saw them)
//
// Leave booked straight after leave (the next business day, or the same day)
// continues it, so the return date is after the last of the run. The return date
// is the first business day after the leave ends: weekends are skipped, and so
// are the holidays in ESCALATION_HOLIDAYS when that is set (Floorplan has no
// public-holiday calendar of its own yet).
//
// What kind of leave it is never reaches the words: they are written to the permanent
// ledger, and a person's kind of leave (a sick day) is theirs.
//
// "Approved before the start" uses the leave request's last change time as the
// approval time: an approved request is only ever changed to withdraw it.

import { addBusinessDays, isBusinessDay, previousBusinessDay, type Holidays } from "../escalation/businessTime";
import { addDaysIso } from "../darwinDate";
import type { AbsentPerson } from "./types";

export interface LeaveFact {
  /** Darwin date the request was approved (its last change). */
  approvedOn: string;
  endDate: string;
  kind: string;
  requestId: number;
  startDate: string;
  userId: number;
}

export interface StaffFact {
  name: string;
  role: string;
  userId: number;
}

/** DD/MM/YYYY, as the screens write dates. */
export function displayDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}

/** The first business day after `endDate`. */
export function returnDateAfter(endDate: string, holidays: Holidays): string {
  return addBusinessDays(endDate, 1, holidays);
}

/** Business days strictly between the day last seen and today: the days that finished with no sign-in. */
export function quietBusinessDays(lastSeenOn: string, today: string, holidays: Holidays): number {
  let count = 0;
  for (let day = addDaysIso(lastSeenOn, 1); day < today; day = addDaysIso(day, 1)) {
    if (isBusinessDay(day, holidays)) count += 1;
  }
  return count;
}

/** The leave covering today, run on through leave that follows it straight away. */
function leaveRun(person: LeaveFact[], today: string, holidays: Holidays): { covering: LeaveFact; end: string } | null {
  const covering = person
    .filter((leave) => leave.startDate <= today && today <= leave.endDate)
    .sort((a, b) => b.endDate.localeCompare(a.endDate) || b.requestId - a.requestId)[0];
  if (!covering) return null;
  let end = covering.endDate;
  for (;;) {
    const back = returnDateAfter(end, holidays);
    const next = person
      .filter((leave) => leave.startDate <= back && leave.endDate > end)
      .sort((a, b) => b.endDate.localeCompare(a.endDate))[0];
    if (!next) return { covering, end };
    end = next.endDate;
  }
}

function onLeave(staff: StaffFact, run: { covering: LeaveFact; end: string }, holidays: Holidays): AbsentPerson {
  const { covering } = run;
  const planned = covering.approvedOn < covering.startDate;
  return {
    endDate: run.end,
    kind: planned ? "planned" : "unplanned",
    lastSeenOn: null,
    leaveKind: covering.kind,
    leaveRequestId: covering.requestId,
    name: staff.name,
    quietBusinessDays: null,
    reason: planned ? `On leave until ${displayDate(run.end)}` : `Away on leave that was not planned, until ${displayDate(run.end)}`,
    reasonCode: planned ? "planned_leave" : "unplanned_leave",
    ref: `leave:${covering.requestId}`,
    returnDate: returnDateAfter(run.end, holidays),
    role: staff.role,
    startDate: covering.startDate,
    userId: staff.userId,
  };
}

export interface DetectInput {
  /** Darwin date of the newest access-log event of anyone: how we tell the log is still being written. Null when there is none. */
  accessLogNewestOn: string | null;
  accessLoggingOn: boolean;
  holidays: Holidays;
  inactivityDays: number;
  /** Darwin date each person was last seen, by user id. */
  lastSeenOn: ReadonlyMap<number, string>;
  leaves: readonly LeaveFact[];
  staff: readonly StaffFact[];
  today: string;
}

export interface Detection {
  absent: AbsentPerson[];
  /** False when access logging is off or its log looks stale: no one can be called inactive. */
  inactivityAvailable: boolean;
  /** Why inactivity is unavailable: switched off, or no sign-in by anyone since before the last business day. */
  inactivityReason: "off" | "stale" | null;
  /** Not on leave and not seen at all in the trusted log's window: not away, but not to be chosen as a cover. */
  dormantIds: number[];
}

/**
 * The log is trusted only while somebody, anybody, has signed in since the last business day. If
 * logging was off for a while, or writes fail quietly, every sign-in looks old at once and the whole
 * office would look inactive.
 */
function inactivityReason(input: DetectInput): Detection["inactivityReason"] {
  if (!input.accessLoggingOn) return "off";
  const lastBusinessDay = previousBusinessDay(addDaysIso(input.today, -1), input.holidays);
  return input.accessLogNewestOn === null || input.accessLogNewestOn < lastBusinessDay ? "stale" : null;
}

export function detectAbsences(input: DetectInput): Detection {
  const absent: AbsentPerson[] = [];
  const reason = inactivityReason(input);
  const dormantIds: number[] = [];
  for (const staff of input.staff) {
    const mine = input.leaves.filter((leave) => leave.userId === staff.userId);
    const run = leaveRun(mine, input.today, input.holidays);
    if (run) {
      absent.push(onLeave(staff, run, input.holidays));
      continue;
    }
    const lastSeen = input.lastSeenOn.get(staff.userId);
    if (reason !== null) continue;
    if (lastSeen === undefined) {
      dormantIds.push(staff.userId);
      continue;
    }
    const quiet = quietBusinessDays(lastSeen, input.today, input.holidays);
    if (quiet < input.inactivityDays) continue;
    absent.push({
      endDate: null,
      kind: "inactive",
      lastSeenOn: lastSeen,
      leaveKind: null,
      leaveRequestId: null,
      name: staff.name,
      quietBusinessDays: quiet,
      reason: `Has not signed in since ${displayDate(lastSeen)} (${quiet} business days)`,
      reasonCode: "no_sign_in",
      ref: `inactive:${lastSeen}`,
      returnDate: null,
      role: staff.role,
      startDate: null,
      userId: staff.userId,
    });
  }
  return { absent: absent.sort((a, b) => a.name.localeCompare(b.name) || a.userId - b.userId), dormantIds, inactivityAvailable: reason === null, inactivityReason: reason };
}
