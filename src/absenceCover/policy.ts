// The policy table: does an item move to a cover now, or is it only suggested to a
// manager? Pure and exhaustive over (due date vs return date) x (importance x
// absence kind).
//
//   falls due before the person is back          -> move
//   high importance and unplanned or inactive    -> move
//   anything else                                -> suggest
//
// "Falls due before they are back" means its due day is earlier than the return
// date, so something already overdue counts. With no due date it cannot be said
// to fall due, and when the return is unknown (someone who has not signed in) it
// cannot be said to fall due before it: those wait for a manager, unless they are
// high importance, which moves at once for an unplanned or inactive absence.
// Items only their owner can answer stay put.

import { darwinDateKey } from "../escalation/businessTime";
import type { AbsentPerson, CoverItem, MoveDecision } from "./types";

export function fallsDueBeforeReturn(item: Pick<CoverItem, "dueAt">, absent: Pick<AbsentPerson, "returnDate">): boolean {
  if (item.dueAt === null || absent.returnDate === null) return false;
  return darwinDateKey(item.dueAt) < absent.returnDate;
}

export function decideMove(item: CoverItem, absent: AbsentPerson): MoveDecision {
  if (item.personal) return { action: "stay", reasonCode: "personal" };
  if (fallsDueBeforeReturn(item, absent)) return { action: "move", reasonCode: "due_before_return" };
  if (item.importance === "high" && absent.kind === "unplanned") return { action: "move", reasonCode: "urgent_unplanned" };
  if (item.importance === "high" && absent.kind === "inactive") return { action: "move", reasonCode: "urgent_inactive" };
  if (absent.kind === "inactive") return { action: "suggest", reasonCode: "inactive_not_urgent" };
  if (item.dueAt === null) return { action: "suggest", reasonCode: "no_due_date" };
  return { action: "suggest", reasonCode: item.dueAt && absent.returnDate ? "due_after_return" : "back_in_time" };
}

export const DECISION_TEXT: Record<string, string> = {
  back_in_time: "It can wait until they are back",
  due_after_return: "It is not due until after they are back",
  due_before_return: "It falls due before they are back",
  inactive_not_urgent: "They have not signed in and it is not urgent",
  no_due_date: "It has no due date",
  personal: "Only they can answer it",
  urgent_inactive: "It is urgent and they have not signed in",
  urgent_unplanned: "It is urgent and their leave was not planned",
};
