// What a manual edit of a schedule row may do to its ratchet exemption (WP26c
// review, finding 1). Pure.
//
// A ratchet exemption is a director's override of the lease's ratchet for one
// review row (C9, D23), written when a director approves a rent review with the
// ratchet overridden. Taking it off puts the ratchet back on that row and every
// row after it, so the rent goes up: a director's decision. An edit of the row:
//
//   leaves ratchetExempt off the step   the exemption is kept as stored: a screen
//                                       that dropped the field can't remove it
//   sends it as stored                  kept as stored
//   adds or changes one                 403 for everyone: it comes from a review
//   sends RatchetExemptionRemovalReason removes it. A director only (admin never
//                                       decides, D20); 403 for anyone else. The
//                                       reason is the ledger row's, with the
//                                       exemption as it was
//
// Deleting a row that carries one removes it too, under the same rule. Every
// refusal here is ledgered as `denied` (tenancyScheduleWrite.ts).

import type { RatchetExemption, ScheduledRateStep } from "./scheduledRateStepLogic";
import { readSignOffText } from "./scheduleSignOff";

export const EXEMPTION_NOT_DIRECTOR =
  "This row carries a director's override of the lease's ratchet. Only a director can remove it, with a reason; your edit wasn't saved.";
export const EXEMPTION_NOT_DIRECTOR_DELETE =
  "This row carries a director's override of the lease's ratchet. Only a director can remove it, with a reason; the row wasn't deleted.";
export const EXEMPTION_FROM_REVIEW =
  "A ratchet override is a director's decision: it is written when a director approves a rent review with the lease's ratchet overridden, not by editing the row.";

/** body.RatchetExemptionRemovalReason: trimmed, or null when blank or not text. */
export function readExemptionRemovalReason(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  return readSignOffText((body as Record<string, unknown>).RatchetExemptionRemovalReason);
}

/** The two exemptions hold the same decision (key order aside). */
export function sameExemption(a: RatchetExemption | undefined, b: RatchetExemption | undefined): boolean {
  return !!a && !!b && a.at === b.at && a.byName === b.byName && a.reason === b.reason;
}

export type ExemptionEdit =
  /** Save `step`: the stored exemption, if any, rides along as stored. */
  | { kind: "keep"; step: ScheduledRateStep }
  /** A director takes the exemption off, for `reason`. */
  | { kind: "remove"; reason: string; removed: RatchetExemption; step: ScheduledRateStep }
  | { kind: "refuse"; message: string; rule: string; status: 400 | 403 };

/** What an edit of `stored` into `incoming` does to its exemption. */
export function exemptionEdit(
  stored: ScheduledRateStep | null,
  incoming: ScheduledRateStep,
  removalReason: string | null,
  callerIsDirector: boolean,
): ExemptionEdit {
  const had = stored?.ratchetExempt;
  if (removalReason !== null) {
    if (!had) return { kind: "refuse", message: "This row has no ratchet override to remove.", rule: "no_exemption", status: 400 };
    if (!callerIsDirector) return { kind: "refuse", message: EXEMPTION_NOT_DIRECTOR, rule: "not_director", status: 403 };
    if (incoming.ratchetExempt) {
      return { kind: "refuse", message: "To remove the ratchet override, send the row without it.", rule: "exemption_still_sent", status: 400 };
    }
    const { ratchetExempt: _off, ...step } = incoming;
    return { kind: "remove", reason: removalReason, removed: had, step };
  }
  if (incoming.ratchetExempt) {
    if (sameExemption(had, incoming.ratchetExempt)) return { kind: "keep", step: { ...incoming, ratchetExempt: had } };
    return { kind: "refuse", message: EXEMPTION_FROM_REVIEW, rule: had ? "exemption_changed" : "exemption_added", status: 403 };
  }
  if (!had) return { kind: "keep", step: incoming };
  // A commencement row can't carry one, so making the row one takes it off.
  if (incoming.methodKind === "commencement") {
    return callerIsDirector
      ? { kind: "refuse", message: "Making this row a commencement row removes its ratchet override: say why (RatchetExemptionRemovalReason).", rule: "reason_required", status: 400 }
      : { kind: "refuse", message: EXEMPTION_NOT_DIRECTOR, rule: "not_director", status: 403 };
  }
  return { kind: "keep", step: { ...incoming, ratchetExempt: had } };
}

/** Deleting `stored`: a row without an exemption is any editor's; one with it is a director's removal. */
export function exemptionDelete(stored: ScheduledRateStep, removalReason: string | null, callerIsDirector: boolean): ExemptionEdit {
  const had = stored.ratchetExempt;
  if (!had) return { kind: "keep", step: stored };
  if (!callerIsDirector) return { kind: "refuse", message: EXEMPTION_NOT_DIRECTOR_DELETE, rule: "not_director", status: 403 };
  if (removalReason === null) {
    return { kind: "refuse", message: "Deleting this row removes its ratchet override: say why (RatchetExemptionRemovalReason).", rule: "reason_required", status: 400 };
  }
  return { kind: "remove", reason: removalReason, removed: had, step: stored };
}
