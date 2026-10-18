// The named manager's notice for an attributed quote approval or a variance
// accepted within the margin (R2, R13): raised after the decision has
// committed, so a missing policy or a mail failure can never undo an approval.
// A notice that fails here is raised by the escalation sweep, which looks for
// every unanswered attribution (listUnansweredAttributions).

import type { Connection } from "tedious";
import { raise } from "./escalation/engine";
import "./escalation/adapters";
import { ATTRIBUTION_SUBJECT_TYPE, attributionSubjectId, noticePolicy, type AttributionRef } from "./escalation/adapters/approvalAttribution";
import type { LedgerActor } from "./ledger/types";
import { Sentry } from "./sentry";

export async function raiseAttributionNotice(
  connection: Connection,
  input: { actor: LedgerActor; managerUserId: number; ref: AttributionRef },
): Promise<void> {
  try {
    await raise(connection, {
      actor: input.actor,
      policyKey: noticePolicy(input.ref.kind),
      subjectId: attributionSubjectId(input.ref),
      subjectType: ATTRIBUTION_SUBJECT_TYPE,
      userTargets: [input.managerUserId],
    });
  } catch (err) {
    console.error(`[attribution] could not raise the notice for ${attributionSubjectId(input.ref)}; the sweep will:`, err instanceof Error ? err.message : err);
    Sentry.captureException(err, { tags: { area: "attribution-notice" } });
  }
}
