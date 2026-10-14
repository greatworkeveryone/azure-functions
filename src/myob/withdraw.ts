// Withdrawing a MYOB proposal: the proposer, or the CFO, says it shouldn't go.
// Only before anything is in flight (proposed) or after it failed
// (exception); an approved proposal is mid-send and can't be withdrawn under
// it. Nothing is deleted: the row stays, marked withdrawn with who and why.

import type { Connection } from "tedious";
import { record } from "../ledger";
import type { Person } from "./propose";
import { ProposalError } from "./proposalErrors";
import { getProposal, updateProposal, type ProposalRow } from "./proposalsStore";

const WITHDRAWABLE = new Set(["proposed", "exception"]);

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
    after: { state: "withdrawn" },
    correlationId: proposal.correlationId,
    jobId: proposal.jobId,
    reason: input.reason,
    subject: { id: proposal.proposalId, type: "myob_proposal" },
  });
  return updated;
}
