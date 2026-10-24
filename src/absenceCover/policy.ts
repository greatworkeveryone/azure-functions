// The policy table: does an item move to a cover now, or is it only suggested to a
// manager? Pure and exhaustive over (due date vs return date) x (importance x
// absence kind).
//
//   the person only stopped signing in          -> suggest (always: a weak signal never moves work)
//   falls due before the person is back          -> move
//   high importance and unplanned leave          -> move
//   anything else                                -> suggest
//
// "Falls due before they are back" means its due day is earlier than the return
// date, so something already overdue counts. With no due date it cannot be said
// to fall due, and those wait for a manager, unless they are high importance,
// which moves at once for an unplanned absence.
// Items only their owner can answer stay put. For someone who has only stopped signing in, nothing
// ever moves by itself: every item is a suggestion (the access log is a weak signal of absence).

import { darwinDateKey } from "../escalation/businessTime";
import type { AbsentPerson, CoverItem, MoveDecision } from "./types";

export function fallsDueBeforeReturn(item: Pick<CoverItem, "dueAt">, absent: Pick<AbsentPerson, "returnDate">): boolean {
  if (item.dueAt === null || absent.returnDate === null) return false;
  return darwinDateKey(item.dueAt) < absent.returnDate;
}

export function decideMove(item: CoverItem, absent: AbsentPerson): MoveDecision {
  if (item.personal) return { action: "stay", reasonCode: "personal" };
  // Someone who has stopped opening the app may simply be in the field or in meetings: inactivity
  // never moves anything by itself. A manager decides, with the item in front of them.
  if (absent.kind === "inactive") return { action: "suggest", reasonCode: "inactive_suggest_only" };
  if (fallsDueBeforeReturn(item, absent)) return { action: "move", reasonCode: "due_before_return" };
  if (item.importance === "high" && absent.kind === "unplanned") return { action: "move", reasonCode: "urgent_unplanned" };
  if (item.dueAt === null) return { action: "suggest", reasonCode: "no_due_date" };
  return { action: "suggest", reasonCode: item.dueAt && absent.returnDate ? "due_after_return" : "back_in_time" };
}

export const DECISION_TEXT: Record<string, string> = {
  back_in_time: "It can wait until they are back",
  due_after_return: "It is not due until after they are back",
  due_before_return: "It falls due before they are back",
  inactive_suggest_only: "They have not signed in, which may only mean they are busy elsewhere, so a manager decides",
  no_due_date: "It has no due date",
  personal: "Only they can answer it",
  urgent_unplanned: "It is urgent and their leave was not planned",
};
