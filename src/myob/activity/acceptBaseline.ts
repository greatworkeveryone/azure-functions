// "Accept MYOB's record as the baseline" (SPR-M4; the M10 review's carry):
// after a hand edit in MYOB that the CFO has checked and agrees with, Floorplan
// takes MYOB's record and its RowVersion, from a read made for this click, as
// what it last saw. The discrepancy clears and a later "Update in MYOB" starts
// from MYOB's record. CFO only (the M9 controller gate), with her note, ledgered
// as myob.control_change.
//
// It covers only what isn't Floorplan's money or identity (memo, comment, line
// descriptions, other dates, freight: acceptedBaseline.ts); a difference in
// amount, supplier, account, tax, number or date is refused, since taking
// MYOB's value into Floorplan isn't built. It changes only Floorplan's mirror
// of the record (dbo.MyobProposals): never MYOB (the read is GET-only), never a
// Floorplan record, and never an invoice's mirror.

import type { Connection } from "tedious";
import { record as ledgerRecord, type LedgerActor } from "../../ledger";
import type { MyobActor } from "../../myob-api-log";
import { MyobControlsError } from "../../myob-controls-admin";
import { KIND_OF } from "../kinds";
import type { ProposalRow } from "../proposalRow";
import { getProposal, latestVerifiedForUid, updateProposal } from "../proposalsStore";
import { MyobPurchaseError, type MyobReader } from "../readbackClient";
import { compareReadback } from "../readbackCompare";
import { acceptanceProblems } from "./acceptedBaseline";

export interface AcceptInput {
  expectedRowVersion: string;
  /** MYOB's record, read for this click (readForAcceptance); null when MYOB no longer has it. */
  myobRecord: Record<string, unknown> | null;
  /** The RowVersion she saw in the reconciliation. */
  myobRowVersion: string;
  note: string;
  proposalId: number;
}

/** Reads MYOB's record now, through the GET-only reader. A 404 is "no record". */
export async function readForAcceptance(proposal: ProposalRow, actor: MyobActor, reader: MyobReader): Promise<Record<string, unknown> | null> {
  try {
    return await reader.get(KIND_OF[proposal.operation], proposal.companyFileId, proposal.myobUid ?? "", actor, proposal.correlationId);
  } catch (error) {
    if (error instanceof MyobPurchaseError && error.status === 404) return null;
    throw error;
  }
}

const refuse = (status: 404 | 409, message: string) => new MyobControlsError(status, message);
const label = (row: ProposalRow) => `${row.rendered?.document ?? "Record"} ${row.myobNumber ?? row.rendered?.number ?? `#${row.proposalId}`}`;

export async function acceptBaseline(tx: Connection, actor: LedgerActor, input: AcceptInput, now: Date): Promise<ProposalRow> {
  const proposal = await getProposal(tx, input.proposalId, true);
  if (!proposal) throw refuse(404, "That MYOB record isn't one Floorplan sent");
  if (proposal.subjectType === "invoice") throw refuse(409, "Floorplan never takes MYOB's record for an invoice: its amounts are fixed once approved or paid");
  if (proposal.state !== "verified" || !proposal.myobUid) throw refuse(409, `This proposal is ${proposal.state}; only a record Floorplan sent and verified has a baseline`);
  if (proposal.rowVersion !== input.expectedRowVersion) throw refuse(409, "Floorplan's record of it changed since you checked. Check against MYOB again.");
  const latest = await latestVerifiedForUid(tx, proposal.companyFileId, proposal.myobUid);
  if (latest?.proposalId !== proposal.proposalId) throw refuse(409, "A later proposal holds this record's baseline. Check against MYOB again.");
  const mine = input.myobRecord;
  if (!mine) throw refuse(409, "MYOB no longer has this record, so there is nothing to accept");
  if (String(mine.RowVersion ?? "") !== input.myobRowVersion) throw refuse(409, "MYOB changed the record again since you checked. Check against MYOB again.");

  const verdict = compareReadback({
    floorplanLastTouch: null, kind: KIND_OF[proposal.operation], lastSeen: proposal.readBack, myob: mine, now,
    previousStatus: proposal.myobStatus, sent: proposal.readBack ?? proposal.payload, sentLabels: { supplier: proposal.rendered?.supplier ?? "the supplier" },
  });
  const blocked = acceptanceProblems(verdict.discrepancy?.fields ?? []);
  if (blocked.length > 0) {
    throw refuse(
      409,
      `MYOB differs in ${blocked.join(", ")}: taking MYOB's value into Floorplan isn't built yet, and accepting it here would leave Floorplan's record and MYOB's disagreeing. Put it right in MYOB or in Floorplan.`,
    );
  }
  const updated = await updateProposal(tx, proposal.proposalId, proposal.rowVersion, {
    Discrepancy: null,
    LastReadBackAt: now,
    MyobRowVersion: input.myobRowVersion,
    MyobSnapshot: JSON.stringify(mine),
    MyobStatus: typeof mine.Status === "string" ? mine.Status.slice(0, 32) : null,
    ReadBack: JSON.stringify(mine),
  });
  if (!updated) throw refuse(409, "Someone else changed this record's MYOB status just now. Check against MYOB again.");
  await ledgerRecord(tx, {
    action: "myob.control_change",
    actor,
    after: { accepted: verdict.discrepancy?.fields ?? [], myobRowVersion: input.myobRowVersion, proposalId: proposal.proposalId, record: label(proposal) },
    before: { discrepancy: proposal.discrepancy, myobRowVersion: proposal.myobRowVersion },
    correlationId: proposal.correlationId,
    jobId: proposal.jobId,
    reason: input.note,
    ruleApplied: "accept_baseline",
    subject: { id: `${proposal.companyFileId}:baseline`, type: "myob_control" },
  });
  return updated;
}
