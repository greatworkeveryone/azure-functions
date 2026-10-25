// What the decision ledger, the job's history and the escalation's context keep about
// a decision and its next step (jobs plan A2). Pure.

import { formatDarwinDateTime } from "../ledger/darwinTime";
import { outcomeLabel } from "../escalation/nextStepEmail";
import type { DecisionRow } from "./decisionsStore";

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

/** The decision as the ledger keeps it. `extra` is added as it stands (who it was
 *  answered as, what the owner is called). */
export function decisionSnapshot(decision: DecisionRow, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decisionId: decision.decisionId,
    deferUntil: decision.deferUntil,
    jobId: decision.jobId,
    nextStep:
      decision.nextStep === null
        ? null
        : {
            closed: decision.nextStepClosed
              ? { at: decision.nextStepClosed.at.toISOString(), by: decision.nextStepClosed.byName, kind: decision.nextStepClosed.kind, note: decision.nextStepClosed.note }
              : null,
            dueAt: iso(decision.nextStepDueAt),
            ownerRole: decision.nextStepOwnerRole,
            ownerUserId: decision.nextStepOwnerUserId,
            text: decision.nextStep,
          },
    outcome: decision.outcome,
    rationale: decision.rationale,
    reaskRequestId: decision.reaskRequestId,
    requestId: decision.requestId,
    respondedAt: decision.respondedAt.toISOString(),
    respondedBy: { name: decision.respondedByName, userId: decision.respondedById },
    ...extra,
  };
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** "17/10/2026": the Darwin day of an instant, day first. */
export const darwinDay = (instant: Date): string => formatDarwinDateTime(instant).slice(0, 10);

/** The line the job's history shows for an answer: the outcome, who, why, and what
 *  happens next. */
export function decisionEventText(
  decision: Pick<DecisionRow, "deferUntil" | "nextStep" | "nextStepDueAt" | "outcome" | "rationale" | "respondedByName">,
  ownerName: string | null,
): string {
  const lines = [`${outcomeLabel(decision.outcome)} by ${decision.respondedByName}: ${decision.rationale}`];
  if (decision.nextStep !== null && ownerName !== null) {
    const due = decision.nextStepDueAt ? `, due ${darwinDay(decision.nextStepDueAt)}` : "";
    lines.push(`Next step for ${ownerName}${due}: ${oneLine(decision.nextStep)}`);
  }
  if (decision.deferUntil !== null) lines.push(`The question comes back on ${decision.deferUntil.split("-").reverse().join("/")}.`);
  return lines.join("\n");
}
