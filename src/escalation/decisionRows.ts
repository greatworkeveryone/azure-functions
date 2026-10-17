// What the escalation engine knows about the escalation behind a decision request
// (jobs plan A1) and behind the next step a decision hands on (A2): the policy that
// carries each, the small block of context it is raised with, and the things that
// make it unlike a stalled job. Pure.
//
//  * It goes to a group of named people. The ladder's `userTarget` level can name
//    several people, and such a row has neither a role nor a single person on it
//    (ladder.ts), so who it is for is in its context (`userTargets`). namedTargetIds
//    reads that, and the inbox query, the permission checks, the emails and the
//    morning digest all use it, so each of the people asked sees the request and is
//    told about it.
//  * It has a schedule. Reminders are not an escalation level: they are instants
//    written into the row's context when it is raised, and the sweep sends one when
//    its time has come and the people have not been told since (reminders.ts).
//
// The context block, written by the decision request and read here:
//
//   decision  { requestId, question, tier, assignmentMode, respondBy, callThem, autoEscalate, jobLabel,
//               reaskOf? }   (reaskOf { decisionId, deferredUntil, askedBy }: it is a deferred
//             question coming round again, raised by the sweep for the person who first asked)
//   schedule  { remindAt: [ISO], escalateAt: ISO | null }   (escalateAt is null, and the
//             row has no due moment, when autoEscalate is off: an emergency, or an
//             urgent request the raiser did not tick to move up)
//   userTargets  [userId]   (the engine's own, from RaiseInput.userTargets)
//
// The next step a decision hands on (policy job.next_step, an attention escalation on
// the job) is raised with the same schedule block and userTargets, and
//
//   nextStep  { decisionId, requestId, outcome, nextStep, ownerUserId, ownerRole,
//               dueAt, respondedBy, rationale, jobLabel }
//   ladder    { role, userId }   (the engine's own, from RaiseInput.ladderRaiser: whose
//             manager the ladder's raiser_manager level is, when that is not the raiser)

import { normaliseRole } from "./roles";
import type { EscalationRow } from "./types";

/** The policy a decision request raises (migration 137). */
export const DECISION_PENDING_POLICY = "job.decision_pending";

/** The policy the next step of a decision raises (migration 138). */
export const NEXT_STEP_POLICY = "job.next_step";

export const isDecisionPolicy = (policyKey: string): boolean => policyKey === DECISION_PENDING_POLICY;

export const isDecisionRow = (row: Pick<EscalationRow, "policyKey">): boolean => isDecisionPolicy(row.policyKey);

export const isNextStepPolicy = (policyKey: string): boolean => policyKey === NEXT_STEP_POLICY;

export const isNextStepRow = (row: Pick<EscalationRow, "policyKey">): boolean => isNextStepPolicy(row.policyKey);

export interface DecisionNote {
  assignmentMode: "named" | "role";
  /** Set when this is a deferred question coming round again (jobs plan A2). */
  reaskOf: { askedBy: string; decisionId: number; deferredUntil: string } | null;
  /** An emergency: nobody is chased, the screen and the email say to call. */
  callThem: boolean;
  jobLabel: string | null;
  question: string;
  requestId: number;
  /** When an answer is due; null for an emergency. */
  respondBy: Date | null;
  tier: string;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The decision a row is about, or null when it is not a decision request or its
 *  context is not what a request writes. */
export function decisionOf(row: Pick<EscalationRow, "context" | "policyKey">): DecisionNote | null {
  if (!isDecisionRow(row)) return null;
  const note = asObject(row.context?.decision);
  if (!note || typeof note.question !== "string" || typeof note.requestId !== "number") return null;
  const reask = asObject(note.reaskOf);
  return {
    assignmentMode: note.assignmentMode === "role" ? "role" : "named",
    reaskOf:
      reask && typeof reask.decisionId === "number" && typeof reask.deferredUntil === "string"
        ? { askedBy: typeof reask.askedBy === "string" ? reask.askedBy : "", decisionId: reask.decisionId, deferredUntil: reask.deferredUntil }
        : null,
    callThem: note.callThem === true,
    jobLabel: typeof note.jobLabel === "string" ? note.jobLabel : null,
    question: note.question,
    requestId: note.requestId,
    respondBy: asDate(note.respondBy),
    tier: typeof note.tier === "string" ? note.tier : "",
  };
}

/** When the people first asked are reminded, ascending. Empty when the row has no schedule. */
export function remindersOf(row: Pick<EscalationRow, "context">): Date[] {
  const schedule = asObject(row.context?.schedule);
  const list = schedule?.remindAt;
  if (!Array.isArray(list)) return [];
  return list
    .map(asDate)
    .filter((date): date is Date => date !== null)
    .sort((a, b) => a.getTime() - b.getTime());
}

/** Everyone the row was raised to ask, as the engine recorded it: the `userTargets`
 *  in its context, whatever level it has moved to since. */
export function askedOfIds(row: Pick<EscalationRow, "context">): number[] {
  const list = row.context?.userTargets;
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((id): id is number => typeof id === "number" && Number.isInteger(id)))];
}

/**
 * The people a row is for when its level is a group of named people: it has no
 * role on it, is not flagged for want of an independent target, and its context
 * lists them. Empty otherwise. It stays true after one of them acknowledges, so the
 * others can still see the row.
 */
export function namedTargetIds(row: Pick<EscalationRow, "context" | "noIndependentTarget" | "targetRole">): number[] {
  if (row.noIndependentTarget || normaliseRole(row.targetRole) !== "") return [];
  return askedOfIds(row);
}

// ── The next step ────────────────────────────────────────────────────────────

export interface NextStepNote {
  decisionId: number;
  dueAt: Date | null;
  jobLabel: string | null;
  nextStep: string;
  outcome: string;
  ownerRole: string | null;
  ownerUserId: number | null;
  rationale: string;
  requestId: number;
  respondedBy: string;
}

/** The next step a row is about, or null when it is not a next-step row or its
 *  context is not what a decision writes. */
export function nextStepOf(row: Pick<EscalationRow, "context" | "policyKey">): NextStepNote | null {
  if (!isNextStepRow(row)) return null;
  const note = asObject(row.context?.nextStep);
  if (!note || typeof note.nextStep !== "string" || typeof note.decisionId !== "number") return null;
  return {
    decisionId: note.decisionId,
    dueAt: asDate(note.dueAt),
    jobLabel: typeof note.jobLabel === "string" ? note.jobLabel : null,
    nextStep: note.nextStep,
    outcome: typeof note.outcome === "string" ? note.outcome : "",
    ownerRole: typeof note.ownerRole === "string" && note.ownerRole !== "" ? note.ownerRole : null,
    ownerUserId: typeof note.ownerUserId === "number" ? note.ownerUserId : null,
    rationale: typeof note.rationale === "string" ? note.rationale : "",
    requestId: typeof note.requestId === "number" ? note.requestId : 0,
    respondedBy: typeof note.respondedBy === "string" ? note.respondedBy : "",
  };
}

/** Who the ladder is about when that is not the person who raised the row: the
 *  role whose manager `raiser_manager` means, and the person (if it is one person)
 *  who is left out of every level but a named one. Null when the row has none, and
 *  the raiser stands in. */
export interface LadderRaiser {
  role: string;
  userId: number | null;
}

export function ladderOf(context: EscalationRow["context"]): LadderRaiser | null {
  const ladder = asObject(context?.ladder);
  if (!ladder || typeof ladder.role !== "string" || normaliseRole(ladder.role) === "") return null;
  return {
    role: normaliseRole(ladder.role),
    userId: typeof ladder.userId === "number" && Number.isInteger(ladder.userId) ? ladder.userId : null,
  };
}
