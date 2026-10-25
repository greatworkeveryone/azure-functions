// Who may answer a decision request (jobs plan A2), as pure rules over the request
// and the person. Not the role gate (roles.ts RESPOND_TO_DECISION_ROLES lets in
// whoever can be asked at all): this is whether THIS person is one of the people
// THIS question was put to.
//
//   named     the people named when it was asked, and nobody else
//   role      everyone who holds the role NOW. The request keeps who held it when it
//             was asked (so the emails and the inbox have names), but the answer
//             does not: someone given the role since may answer, and someone who has
//             lost it may not
//
// The person who asked never answers their own question, even if they hold the role
// it was put to: the ask refuses to name them (people.ts), and a role request leaves
// them out of the people it goes to. Directors and admin are not decision-makers by
// virtue of their role; they are only if asked.
//
// Admin approves nothing real (beta sprint decision 4): it can no longer be asked
// (roles.ts DECISION_MAKER_ROLES), and a request that names it all the same, from
// before that or written by hand, is answered by admin on a test job only. This is
// the same bar the money handlers apply (moneyRules adminRefusal), and it comes after
// the question of whether admin was asked at all, so an admin who was not asked is
// told so, not told about test jobs.

import { normaliseRole, roleLabel } from "../escalation/roles";
import { adminRefusal } from "../moneyRules";
import type { DecisionRow } from "./decisionsStore";
import { MANAGER_AND_ABOVE_ROLES } from "./roles";
import type { DecisionRequestRow } from "./store";

export interface Responder {
  /** Their roles now, as the request was made (AppUsers.Role, or the dev override). */
  roles: readonly string[];
  /** The request's job is test data (testRecords isTestJob). Only admin's standing depends on it, so
   *  the caller need not look it up for anyone else. Absent means a real job. */
  testJob?: boolean;
  userId: number | null;
}

export type Standing =
  | { allowed: true; via: "named" | "role" }
  | { allowed: false; code: "admin_test_jobs_only" | "asker" | "not_named" | "not_in_role"; message: string };

const ADMIN_TEST_JOBS_ONLY = "Admin answers questions on test jobs only. This is a real job, so someone else has to answer it.";

type StandingRequest = Pick<DecisionRequestRow, "assignmentMode" | "decisionMakers" | "requestedByUserId">;

export function responderStanding(request: StandingRequest, who: Responder, askedNames: readonly string[] = []): Standing {
  const standing = standingOnRequest(request, who, askedNames);
  if (standing.allowed && adminRefusal(who.roles, who.testJob === true)) {
    return { allowed: false, code: "admin_test_jobs_only", message: ADMIN_TEST_JOBS_ONLY };
  }
  return standing;
}

function standingOnRequest(request: StandingRequest, who: Responder, askedNames: readonly string[]): Standing {
  if (who.userId !== null && request.requestedByUserId === who.userId) {
    return { allowed: false, code: "asker", message: "You asked this question, so someone else has to answer it." };
  }

  if (request.assignmentMode === "role") {
    const role = normaliseRole(request.decisionMakers.role);
    if (role !== "" && who.roles.some((held) => normaliseRole(held) === role)) return { allowed: true, via: "role" };
    return {
      allowed: false,
      code: "not_in_role",
      message: `This question was put to everyone in the ${roleLabel(role)} role. You don't hold that role, so you can't answer it.`,
    };
  }

  if (who.userId !== null && request.decisionMakers.userIds.includes(who.userId)) return { allowed: true, via: "named" };
  return {
    allowed: false,
    code: "not_named",
    message:
      askedNames.length > 0
        ? `This question was put to ${askedNames.join(", ")}. You weren't asked, so you can't answer it.`
        : "This question was put to particular people and you aren't one of them, so you can't answer it.",
  };
}

// ── Finishing a next step ────────────────────────────────────────────────────

export type StepStanding =
  | { allowed: true; as: "owner" | "role" | "manager" }
  | { allowed: false; message: string };

/**
 * Who may mark a next step done: the person it was handed to, anyone who holds the
 * role it was handed to now, or a manager and above (MANAGER_AND_ABOVE_ROLES) for
 * any step: the job still has to be finished when its owner is away or has left.
 */
export function stepStanding(
  decision: Pick<DecisionRow, "nextStepOwnerRole" | "nextStepOwnerUserId">,
  who: Responder,
  ownerName: string | null = null,
): StepStanding {
  if (decision.nextStepOwnerUserId !== null && who.userId !== null && decision.nextStepOwnerUserId === who.userId) return { allowed: true, as: "owner" };
  const ownerRole = normaliseRole(decision.nextStepOwnerRole);
  if (ownerRole !== "" && who.roles.some((held) => normaliseRole(held) === ownerRole)) return { allowed: true, as: "role" };
  if (who.roles.some((held) => MANAGER_AND_ABOVE_ROLES.includes(normaliseRole(held)))) return { allowed: true, as: "manager" };
  const whose = ownerRole !== "" ? `everyone in the ${roleLabel(ownerRole)} role` : (ownerName ?? "someone else");
  return { allowed: false, message: `This step was handed to ${whose}. Only they, or a manager, can mark it done.` };
}
