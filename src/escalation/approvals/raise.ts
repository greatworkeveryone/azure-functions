// Raising and ending the approval escalations from the handler that made the request or the one that answers it.
// Both run after the handler's own transaction has committed and never throw: an escalation that cannot be
// written never undoes a request or a decision. A policy that is switched off (the seeded state) or not yet
// migrated is a quiet no-op, logged once per call.

import type { Connection } from "tedious";
import { concludeForSubject, raise } from "../engine";
import { EscalationError } from "../errors";
import type { LedgerActor } from "../../ledger";
import { Sentry } from "../../sentry";
import { errorMessage } from "../../errorMessage";
import type { EscalationRow } from "../types";

/** A logger that never throws: logging must not turn a handled failure into a failed request. */
const safeLog = (log: ((message: string) => void) | undefined) => (message: string): void => {
  try {
    log?.(message);
  } catch {
    // nothing to do
  }
};

const isPolicyOff = (error: unknown): boolean =>
  error instanceof EscalationError && (error.code === "policy_inactive" || error.code === "unknown_policy");

export interface RaiseApprovalInput {
  actor: LedgerActor;
  /** Whoever prepared the thing and may not be the one to approve it. */
  excludeUserIds?: readonly number[];
  headline: string;
  log?: (message: string) => void;
  policyKey: string;
  startAtRole?: string | null;
  subjectId: string;
  subjectType: string;
  /** The named approvers, for a policy whose first level is `userTarget`. */
  userTargets?: readonly number[];
}

/** Null when it is off, failed, or was already live. */
export async function raiseApproval(connection: Connection, input: RaiseApprovalInput): Promise<EscalationRow | null> {
  const log = safeLog(input.log);
  try {
    const { created, escalation } = await raise(connection, {
      actor: input.actor,
      excludeUserIds: input.excludeUserIds,
      headline: input.headline,
      policyKey: input.policyKey,
      startAtRole: input.startAtRole,
      subjectId: input.subjectId,
      subjectType: input.subjectType,
      userTargets: input.userTargets,
    });
    return created ? escalation : null;
  } catch (error) {
    if (isPolicyOff(error)) {
      log(`approvals: ${input.policyKey} is switched off or missing, so ${input.subjectType} ${input.subjectId} waits without a chase`);
      return null;
    }
    const message = errorMessage(error);
    log(`approvals: could not raise ${input.policyKey} on ${input.subjectType} ${input.subjectId}: ${message}`);
    Sentry.captureException(error, { extra: { context: "approval escalation: raise", policyKey: input.policyKey, subjectId: input.subjectId } });
    return null;
  }
}

export interface ConcludeApprovalInput {
  actor: LedgerActor;
  /** approved | declined | withdrawn | published | ...: lower case words joined by underscores. */
  code: string;
  log?: (message: string) => void;
  note?: string | null;
  policyKeys: readonly string[];
  subjectId: string;
  subjectType: string;
  /** The asker took it back: an escalation nobody has picked up is withdrawn, not resolved. */
  withdrawn?: boolean;
}

/** How many ended. */
export async function concludeApproval(connection: Connection, input: ConcludeApprovalInput): Promise<number> {
  const log = safeLog(input.log);
  try {
    const ended = await concludeForSubject(connection, {
      actor: input.actor,
      code: input.code,
      note: input.note ?? null,
      policyKeys: input.policyKeys,
      subjectId: input.subjectId,
      subjectType: input.subjectType,
      withdrawOpen: input.withdrawn === true,
    });
    return ended.length;
  } catch (error) {
    if (isPolicyOff(error)) return 0;
    log(`approvals: could not end ${input.policyKeys.join(", ")} on ${input.subjectType} ${input.subjectId}: ${errorMessage(error)}`);
    Sentry.captureException(error, { extra: { context: "approval escalation: conclude", code: input.code, subjectId: input.subjectId } });
    return 0;
  }
}
