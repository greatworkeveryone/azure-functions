// The plan for one run: for every item of someone who is away, what the policy says
// (policy.ts), who the cover would be (resolveCover.ts), and what would be written.
// Pure: the run's reads come in as arguments, so the whole decision is testable
// without a database, and the dry run and the live run plan identically.
//
// Idempotent by what the ledger already says about the item (its latest row):
//   already suggested for this absence   not suggested again
//   kept by a manager for this absence   left alone for it
//   taken back by the person             left alone for this absence (that row runs from the cover to the person)
// An item that was moved is no longer on the absent person's list, so it is never
// moved twice. A shared queue (a quote awaiting approval) is only an item while
// nobody else who is in could take it; a leave approval is one only because its
// adapter found every approver the leave rules allow to be away.

import type { CoverActionRow } from "./coverActionStore";
import { itemKey } from "./coverActionStore";
import { someoneElseCanCover } from "./eligibility";
import { isMovable } from "./moves/domain";
import { decideMove, DECISION_TEXT } from "./policy";
import { resolveCover, SOURCE_TEXT } from "./resolveCover";
import { IMPORTANCE_RANK, type AbsentPerson, type CoverContext, type CoverItem, type CoverResolution, type MoveDecision } from "./types";

export interface PlanEntry {
  absent: AbsentPerson;
  /** What a live run writes: the move, or only a suggestion. */
  action: "escalated" | "reassigned" | "suggested";
  decision: MoveDecision;
  item: CoverItem;
  /** The ledger's latest row on the item, when it has one. */
  last: CoverActionRow | null;
  reasonCode: string;
  reasonText: string;
  resolution: CoverResolution;
}

export interface Plan {
  alreadyHandled: number;
  entries: PlanEntry[];
  notStranded: number;
  stayed: number;
}

const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

/** The sentence a ledger row and the manager's screen give as the reason. */
export function reasonTextFor(entry: Pick<PlanEntry, "absent" | "decision" | "resolution">, wrote: PlanEntry["action"]): string {
  const { absent, decision, resolution } = entry;
  const why = DECISION_TEXT[decision.reasonCode] ?? "";
  const parts = [sentence(why), sentence(absent.reason)];
  for (const skipped of resolution.skipped) parts.push(sentence(`${skipped.name}, ${SOURCE_TEXT[skipped.source]}, ${skipped.reason}`));
  if (resolution.found) {
    parts.push(sentence(`${wrote === "suggested" ? "Suggested cover" : wrote === "escalated" ? "Escalated to" : "Moved to"} ${resolution.name}, ${SOURCE_TEXT[resolution.source]}`));
  } else {
    parts.push("Nobody who may take it is available, so a manager needs to choose.");
  }
  return parts.join(" ");
}

function writeFor(item: CoverItem, decision: MoveDecision, resolution: CoverResolution): { action: PlanEntry["action"]; code: string } {
  if (decision.action !== "move") return { action: "suggested", code: decision.reasonCode };
  if (!resolution.found) return { action: "suggested", code: "no_cover" };
  if (!isMovable(item.move)) return { action: "suggested", code: "not_movable" };
  return { action: resolution.action, code: decision.reasonCode };
}

const urgency = (a: PlanEntry, b: PlanEntry): number =>
  IMPORTANCE_RANK[b.item.importance] - IMPORTANCE_RANK[a.item.importance] ||
  (a.item.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.item.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER) ||
  a.item.type.localeCompare(b.item.type) ||
  Number(a.item.id) - Number(b.item.id);

export function planCover(input: {
  absent: readonly AbsentPerson[];
  context: CoverContext;
  items: readonly CoverItem[];
  latest: ReadonlyMap<string, CoverActionRow>;
}): Plan {
  const plan: Plan = { alreadyHandled: 0, entries: [], notStranded: 0, stayed: 0 };
  for (const item of input.items) {
    const absent = input.absent.find((person) => person.userId === item.ownerUserId);
    if (!absent) continue;
    if (item.move === "notice" && someoneElseCanCover(item, input.context)) {
      plan.notStranded += 1;
      continue;
    }
    const last = input.latest.get(itemKey(item.type, item.id)) ?? null;
    const sameAbsence = last !== null && last.absenceRef === absent.ref && (last.fromUserId === absent.userId || last.toUserId === absent.userId);
    if (sameAbsence && (last.action === "kept" || last.action === "taken_back")) {
      plan.alreadyHandled += 1;
      continue;
    }
    const decision = decideMove(item, absent);
    if (decision.action === "stay") {
      plan.stayed += 1;
      continue;
    }
    const resolution = resolveCover(item, absent, input.context);
    const { action, code } = writeFor(item, decision, resolution);
    const entry: PlanEntry = { absent, action, decision, item, last, reasonCode: code, reasonText: "", resolution };
    entry.reasonText = reasonTextFor(entry, action);
    plan.entries.push(entry);
  }
  plan.entries.sort(urgency);
  return plan;
}
