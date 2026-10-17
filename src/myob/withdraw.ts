// Withdrawing a MYOB proposal: the proposer, or the CFO, says it shouldn't go.
// Allowed while nothing is in flight: proposed, approved (Floorplan's controls
// held the send back), exception (it failed), or pushed once the push can't
// still be running (pushState.ts) — so the CFO is never forced to re-send a
// write she no longer wants (decision 12). That last case is ledgered with a
// warning: MYOB may already hold the record, and if so it is voided in MYOB by
// hand. Nothing is deleted: the row stays, marked withdrawn with who and why.

import type { Connection } from "tedious";
import { record } from "../ledger";
import type { Person } from "./propose";
import { ProposalError } from "./proposalErrors";
import { getProposal, updateProposal, type ProposalRow } from "./proposalsStore";
import { pushInFlight } from "./pushState";

const WITHDRAWABLE = new Set(["proposed", "approved", "exception", "pushed"]);
export const MAY_BE_IN_MYOB =
  "It was sent to MYOB and MYOB's answer never arrived: MYOB may already hold the record. Check MYOB; if it is there, it is voided in MYOB by hand.";

export async function withdrawProposal(
  tx: Connection,
  person: Person,
  isController: boolean,
  input: { expectedRowVersion: string; proposalId: number; reason: string },
  now: Date,
): Promise<ProposalRow> {
  const proposal = await getProposal(tx, input.proposalId, true);
  if (!proposal) throw new ProposalError(404, "That MYOB proposal doesn't exist");
  const isProposer = proposal.proposedByOid ? proposal.proposedByOid === person.oid : proposal.proposedBy === person.name;
  if (!isProposer && !isController) throw new ProposalError(403, "Only the person who proposed it, or the CFO, can withdraw a MYOB proposal");
  if (!WITHDRAWABLE.has(proposal.state)) throw new ProposalError(409, `This proposal is ${proposal.state}, so it can't be withdrawn`);
  if (pushInFlight(proposal, now)) {
    throw new ProposalError(409, "This proposal is being sent to MYOB now. It can be withdrawn once MYOB answers, or after 15 minutes.");
  }
  const unanswered = proposal.state === "pushed";
  if (proposal.rowVersion !== input.expectedRowVersion) throw new ProposalError(409, "Someone else acted on this proposal since you opened it. Reload.");

  const updated = await updateProposal(tx, proposal.proposalId, proposal.rowVersion, {
    State: "withdrawn",
    WithdrawnAt: now,
    WithdrawnBy: person.name.slice(0, 200),
    WithdrawReason: input.reason.slice(0, 1000),
  });
  if (!updated) throw new ProposalError(409, "Someone else acted on this proposal since you opened it. Reload.");
  await record(tx, {
    action: "myob.withdraw",
    actor: person.ledger,
    before: { state: proposal.state },
    after: unanswered ? { state: "withdrawn", warning: MAY_BE_IN_MYOB } : { state: "withdrawn" },
    correlationId: proposal.correlationId,
    jobId: proposal.jobId,
    reason: input.reason,
    ...(unanswered ? { ruleApplied: "withdrawn_after_unanswered_push" } : {}),
    subject: { id: proposal.proposalId, type: "myob_proposal" },
  });
  return updated;
}
