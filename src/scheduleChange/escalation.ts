// A pending schedule change's escalation (WP26c): schedule.change_ratification,
// authority, to the directors (migration 099). Raised once a request commits,
// ended once a director's decision or the requester's withdrawal commits. Never
// part of the decision's transaction: an escalation that fails to move never
// undoes a decision. A failure is logged and sent to Sentry; the escalation sweep
// reminds the directors of a live one, and a decision ends whatever is live.

import type { Connection } from "tedious";
import { concludeForSubject, EscalationError, raise, type EscalationRow } from "../escalation";
import type { LedgerActor } from "../ledger";
import { Sentry } from "../sentry";
import { RATIFICATION_POLICY, SCHEDULE_CHANGE_SUBJECT } from "./types";

function report(what: string, requestId: string, error: unknown, log?: (message: string) => void): void {
  const message = error instanceof Error ? error.message : String(error);
  log?.(`scheduleChangeEscalation: ${what} on request ${requestId} failed: ${message}`);
  Sentry.captureException(error, { extra: { context: `schedule change escalation: ${what}`, requestId } });
}

const isPolicyOff = (error: unknown): boolean =>
  error instanceof EscalationError && (error.code === "policy_inactive" || error.code === "unknown_policy");

export interface RaiseRatificationInput {
  /** The person who asked: the engine never sends an escalation to whoever raised it. */
  actor: LedgerActor;
  headline: string;
  log?: (message: string) => void;
  requestId: string;
}

/** To the directors, for a request that just committed. Null when it couldn't be raised. */
export async function raiseRatification(connection: Connection, input: RaiseRatificationInput): Promise<EscalationRow | null> {
  try {
    const { escalation } = await raise(connection, {
      actor: input.actor,
      headline: input.headline,
      policyKey: RATIFICATION_POLICY,
      subjectId: input.requestId,
      subjectType: SCHEDULE_CHANGE_SUBJECT,
    });
    return escalation;
  } catch (error) {
    if (isPolicyOff(error)) {
      input.log?.(`scheduleChangeEscalation: ${RATIFICATION_POLICY} is switched off or missing; request ${input.requestId} waits without it`);
      return null;
    }
    report("raising the ratification", input.requestId, error, input.log);
    return null;
  }
}

export interface SettleRatificationInput {
  actor: LedgerActor;
  /** ratified | rejected | withdrawn */
  code: string;
  log?: (message: string) => void;
  note: string | null;
  requestId: string;
  /** The person who asked took it back: an escalation nobody acknowledged is withdrawn. */
  withdrawn?: boolean;
}

/** Ends the request's live ratification escalation with the decision. Never throws; returns how many ended. */
export async function settleRatification(connection: Connection, input: SettleRatificationInput): Promise<number> {
  try {
    const ended = await concludeForSubject(connection, {
      actor: input.actor,
      code: input.code,
      note: input.note,
      policyKeys: [RATIFICATION_POLICY],
      subjectId: input.requestId,
      subjectType: SCHEDULE_CHANGE_SUBJECT,
      withdrawOpen: input.withdrawn === true,
    });
    return ended.length;
  } catch (error) {
    report(`ending the ratification (${input.code})`, input.requestId, error, input.log);
    return 0;
  }
}
