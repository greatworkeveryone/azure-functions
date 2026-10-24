// The in-app notice to a cover (policy cover.moved, the absence_cover adapter). Raised
// inside the move's transaction, so the move, its ledger row and its notice commit or
// roll back together; the email (if mail is set up) goes out after the commit, through
// the existing escalation notifier, which honours DEV_EMAIL_OVERRIDE and never throws
// for a failed send. A policy an admin has switched off means no notice, not no move.

import type { Connection } from "tedious";
import { ABSENCE_COVER_SUBJECT } from "../../escalation/adapters/absenceCover";
import { raiseWithin } from "../../escalation/engine";
import { EscalationError } from "../../escalation/errors";
import { COVER_ACTOR_NAME } from "../types";

const COVER_NOTICE_POLICY = "cover.moved";

export interface NoticeInput {
  coverActionId: number;
  deepLink: string;
  toUserId: number;
}

/** Returns a function that sends the notice's email after the caller has committed. */
export async function raiseCoverNotice(connection: Connection, input: NoticeInput): Promise<() => Promise<void>> {
  try {
    const raised = await raiseWithin(connection, {
      actor: { kind: "system", name: COVER_ACTOR_NAME },
      context: { deepLink: input.deepLink },
      policyKey: COVER_NOTICE_POLICY,
      skipConditionCheck: true,
      subjectId: String(input.coverActionId),
      subjectType: ABSENCE_COVER_SUBJECT,
      userTargets: [input.toUserId],
    });
    return async () => {
      await raised.announce();
    };
  } catch (error) {
    if (error instanceof EscalationError && error.code === "policy_inactive") return async () => undefined;
    throw error;
  }
}
