// Scheduled reminders (jobs plan A1, decision D5). An escalation can carry the
// moments its people should be reminded in its context (`schedule.remindAt`,
// decisionRows.ts); this says which of them is due. Pure. The sweep sends the
// reminder (sweep.ts) with the notifier's "reminder" email.
//
// A reminder is not an escalation level and creates no row: it is an email to the
// people the row is already for. The row is the cursor. A reminder is due when its
// time has come and the people have not been told since, so "last told" is the
// time the notifier last got a send through (LastNotifiedAt: the raise, a retry or
// an earlier reminder). That makes the sweep idempotent (a second run the same
// half hour finds nothing due), lets a failed send be tried again on the next run
// without sending twice, and means a sweep that was off for a week sends one
// reminder when it comes back, not one for every time it missed.

import { remindersOf } from "./decisionRows";
import { LIVE_STATUSES, type EscalationRow } from "./types";

/**
 * The reminder to send now, or null. The latest of the row's scheduled times that
 * has passed since the people were last told (or, if they never were, since the row
 * was raised). Only a live row is reminded, and only the people first asked: a row
 * that has moved up (it has a parent) belongs to someone else, and its schedule
 * ended with the deadline it was written for.
 */
export function dueReminder(row: EscalationRow, now: Date): Date | null {
  if (!LIVE_STATUSES.includes(row.status)) return null;
  if (row.parentEscalationId !== null) return null;

  const since = (row.lastNotifiedAt ?? row.createdAt).getTime();
  const due = remindersOf(row).filter((at) => at.getTime() > since && at.getTime() <= now.getTime());
  return due.length > 0 ? due[due.length - 1] : null;
}
