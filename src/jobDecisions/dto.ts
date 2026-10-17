// A decision request as the API sends it (jobs plan A1), and the answer to it with the
// next step it hands on (A2): ISO dates, the people by name, and the chase behind
// each (the live escalation and its schedule). Pure.

import { getAdapter } from "../escalation/adapters/registry";
import { darwinDateKey } from "../escalation/businessTime";
import { namedTargetIds, remindersOf } from "../escalation/decisionRows";
import { roleLabel } from "../escalation/roles";
import type { EscalationRow } from "../escalation/types";
import type { DecisionRow } from "./decisionsStore";
import type { DecisionRequestRow, RequestState } from "./store";
import type { DecisionTier } from "./tiers";

export interface PersonDto {
  active: boolean;
  name: string | null;
  role: string | null;
  userId: number;
}

export interface RequestDto {
  assignmentMode: "named" | "role";
  /** Whether it moves up to the raiser's manager on its own when unanswered. Always
   *  true for soon, routine and fixed; false for an emergency; for urgent, the raiser's
   *  tick (off unless ticked). The reminders go out either way. */
  autoEscalate: boolean;
  /** Emergency: nobody is chased; the screen says call them. */
  callThem: boolean;
  decisionMakers: { people: PersonDto[]; role: string | null; roleLabel: string | null };
  /** The date a fixed deadline was given for (Darwin). */
  fixedDate: string | null;
  jobId: number;
  question: string;
  requestedAt: string;
  requestedBy: string;
  requestedByUserId: number | null;
  requestId: number;
  /** When an answer is due, ISO UTC; null for an emergency. */
  respondBy: string | null;
  routineWeeks: number | null;
  /** Base64. Send it back with a withdrawal so a stale screen is a 409. */
  rowVersion: string;
  sourceAttachmentId: number | null;
  state: RequestState;
  tier: DecisionTier;
  withdrawn: { at: string; by: string | null; byUserId: number | null; reason: string | null } | null;
}

export type PeopleById = ReadonlyMap<number, { active: boolean; name: string; role: string | null }>;

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

export function toRequestDto(row: DecisionRequestRow, people: PeopleById): RequestDto {
  return {
    assignmentMode: row.assignmentMode,
    autoEscalate: row.autoEscalate,
    callThem: row.tier === "emergency",
    decisionMakers: {
      people: row.decisionMakers.userIds.map((userId) => {
        const person = people.get(userId);
        return { active: person?.active ?? false, name: person?.name ?? null, role: person?.role ?? null, userId };
      }),
      role: row.decisionMakers.role,
      roleLabel: row.decisionMakers.role ? roleLabel(row.decisionMakers.role) : null,
    },
    fixedDate: row.tier === "fixed" && row.respondBy ? darwinDateKey(row.respondBy) : null,
    jobId: row.jobId,
    question: row.question,
    requestedAt: row.requestedAt.toISOString(),
    requestedBy: row.requestedBy,
    requestedByUserId: row.requestedByUserId,
    requestId: row.requestId,
    respondBy: iso(row.respondBy),
    routineWeeks: row.routineWeeks,
    rowVersion: row.rowVersion,
    sourceAttachmentId: row.sourceAttachmentId,
    state: row.state,
    tier: row.tier,
    withdrawn: row.withdrawnAt
      ? { at: row.withdrawnAt.toISOString(), by: row.withdrawnBy, byUserId: row.withdrawnByUserId, reason: row.withdrawnReason }
      : null,
  };
}

/** The live escalation behind a pending request: who it is with now, when it moves
 *  up and when the people first asked are reminded. */
export interface ChaseDto {
  deepLink: string | null;
  /** When it moves up if nobody has acted; null = never (an emergency, an urgent
   *  request not ticked to move up, or the top of the ladder). */
  dueAt: string | null;
  escalationId: number;
  isOverdue: boolean;
  level: number;
  notificationState: string;
  /** The reminders scheduled for the people first asked, ISO UTC, ascending. */
  remindAt: string[];
  status: string;
  /** The people it is with now when that is a group of named people, else empty. */
  targetNames: string[];
  targetRole: string | null;
  targetRoleLabel: string;
  urgent: boolean;
}

export function toChaseDto(row: EscalationRow | null, directory: readonly { name: string; userId: number }[], now: Date): ChaseDto | null {
  if (!row) return null;
  const adapter = getAdapter(row.subjectType);
  return {
    deepLink: adapter ? adapter.deepLink(row.subjectId) : null,
    dueAt: iso(row.dueAt),
    escalationId: row.escalationId,
    isOverdue: row.status === "open" && row.dueAt !== null && row.dueAt.getTime() <= now.getTime(),
    level: row.level,
    notificationState: row.notificationState,
    remindAt: remindersOf(row).map((instant) => instant.toISOString()),
    status: row.status,
    targetNames: namedTargetIds(row)
      .map((id) => directory.find((user) => user.userId === id)?.name)
      .filter((name): name is string => Boolean(name)),
    targetRole: row.targetRole,
    targetRoleLabel: roleLabel(row.targetRole),
    urgent: row.urgent,
  };
}

// ── The answer, and the step it hands on (jobs plan A2) ──────────────────────

export interface NextStepOwnerDto {
  active: boolean;
  /** The person's name; null for a role (see roleLabel). */
  name: string | null;
  /** Set when the step is for everyone in a role. */
  role: string | null;
  roleLabel: string | null;
  /** Set when the step is for one person. */
  userId: number | null;
}

export interface NextStepDto {
  /** While the step is open, the chase on it: who it is with now and when it moves up. */
  chase: ChaseDto | null;
  /** How it ended; null while it is open. */
  closed: { at: string; by: string; byUserId: number | null; kind: "done" | "replaced"; note: string | null } | null;
  /** When it is due, ISO UTC (close of business on its day in Darwin). */
  dueAt: string;
  /** Open and past its due moment. */
  isOverdue: boolean;
  owner: NextStepOwnerDto;
  /** open until it is marked done (by its owner or a manager) or a later decision takes over. */
  state: "open" | "done" | "replaced";
  text: string;
}

export interface DecisionDto {
  decisionId: number;
  /** The Darwin day a deferred question comes back, YYYY-MM-DD. */
  deferUntil: string | null;
  jobId: number;
  /** null for a deferral with no step. */
  nextStep: NextStepDto | null;
  outcome: "approve" | "deny" | "defer" | "revise";
  rationale: string;
  /** Defer only: the question is asked again on this day, and as this request once it has been. */
  reask: { dueDate: string; requestId: number | null } | null;
  requestId: number;
  respondedAt: string;
  respondedBy: { name: string; userId: number | null };
  /** Base64. Send it back when marking the step done so a stale screen is a 409. */
  rowVersion: string;
}

export function toDecisionDto(row: DecisionRow, people: PeopleById, chase: ChaseDto | null, now: Date): DecisionDto {
  let nextStep: NextStepDto | null = null;
  if (row.nextStep !== null && row.nextStepDueAt !== null) {
    const owner = row.nextStepOwnerUserId === null ? undefined : people.get(row.nextStepOwnerUserId);
    const closed = row.nextStepClosed;
    nextStep = {
      chase: closed ? null : chase,
      closed: closed ? { at: closed.at.toISOString(), by: closed.byName, byUserId: closed.byId, kind: closed.kind, note: closed.note } : null,
      dueAt: row.nextStepDueAt.toISOString(),
      isOverdue: closed === null && row.nextStepDueAt.getTime() <= now.getTime(),
      owner: {
        active: owner?.active ?? row.nextStepOwnerRole !== null,
        name: row.nextStepOwnerUserId === null ? null : (owner?.name ?? null),
        role: row.nextStepOwnerRole,
        roleLabel: row.nextStepOwnerRole ? roleLabel(row.nextStepOwnerRole) : null,
        userId: row.nextStepOwnerUserId,
      },
      state: closed ? closed.kind : "open",
      text: row.nextStep,
    };
  }
  return {
    decisionId: row.decisionId,
    deferUntil: row.deferUntil,
    jobId: row.jobId,
    nextStep,
    outcome: row.outcome,
    rationale: row.rationale,
    reask: row.outcome === "defer" && row.deferUntil ? { dueDate: row.deferUntil, requestId: row.reaskRequestId } : null,
    requestId: row.requestId,
    respondedAt: row.respondedAt.toISOString(),
    respondedBy: { name: row.respondedByName, userId: row.respondedById },
    rowVersion: row.rowVersion,
  };
}
