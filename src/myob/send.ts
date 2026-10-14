// "Approve and send to MYOB" (decision 12). Three steps, so a MYOB call never
// runs inside a database transaction and nothing is marked sent before MYOB
// has said so:
//   1. approve (transaction): the CFO, not the proposer when review is on; the
//      file set to write; the preview hash equal to the payload rebuilt now
//      with her as approver; then state approved, the final payload stored,
//      ledgered myob.approve
//   2. push (no transaction): sendSteps.ts
//   3. record (transaction): verified, or exception with MYOB's words; ledgered
// A refusal inside Floorplan (controls off, dry run, master switch) leaves the
// proposal approved, to be sent again once allowed.

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery } from "../db";
import { record } from "../ledger";
import { myobWebUrl } from "../myob-purchase-order";
import { buildDraft } from "./draft";
import { canonicalJson } from "./hash";
import type { Person } from "./propose";
import { checkPreviewTime, ProposalError } from "./proposalErrors";
import { getProposal, latestVerifiedForUid, updateProposal, type ProposalRow, type ProposalUpdate } from "./proposalsStore";
import { KIND_OF, pushApproved, type MyobPurchases, type PushResult } from "./sendSteps";
import type { ProposalSubjectType } from "./subjects";
import { installFloorplanRecordLookup } from "./floorplanRecords";

installFloorplanRecordLookup();

export interface SendInput {
  expectedRowVersion: string;
  payloadHash: string;
  previewedAt: Date;
  proposalId: number;
}

export interface SendDeps {
  link: (jobId: number | null) => string | null;
  myob: MyobPurchases;
  now: () => Date;
  withTx: <T>(work: (tx: Connection) => Promise<T>) => Promise<T>;
}

export interface SendOutcome {
  message: string;
  outcome: PushResult["kind"];
  proposal: ProposalRow;
}

const SENDABLE = new Set(["proposed", "approved", "exception"]);
const samePerson = (proposal: ProposalRow, person: Person) =>
  proposal.proposedByOid ? proposal.proposedByOid === person.oid : proposal.proposedBy === person.name;

async function reviewRequired(tx: Connection, proposal: ProposalRow): Promise<boolean> {
  const rows = await executeQuery(tx, `SELECT RequireReview FROM dbo.MyobControls WHERE CompanyFileId = @CompanyFileId AND Operation = @Operation`, [
    { name: "CompanyFileId", type: TYPES.NVarChar, value: proposal.companyFileId },
    { name: "Operation", type: TYPES.NVarChar, value: proposal.operation },
  ]);
  return rows[0] ? Boolean(rows[0].RequireReview) : true;
}

async function approve(deps: SendDeps, person: Person, input: SendInput): Promise<ProposalRow> {
  const now = deps.now();
  return deps.withTx(async (tx) => {
    const proposal = await getProposal(tx, input.proposalId, true);
    if (!proposal) throw new ProposalError(404, "That MYOB proposal doesn't exist");
    if (!SENDABLE.has(proposal.state)) throw new ProposalError(409, `This proposal is ${proposal.state}; there is nothing to send.`);
    if (proposal.rowVersion !== input.expectedRowVersion) throw new ProposalError(409, "Someone else acted on this proposal since you opened it. Reload.");
    if ((await reviewRequired(tx, proposal)) && samePerson(proposal, person)) {
      throw new ProposalError(403, "A second person must approve this: you proposed it.");
    }
    checkPreviewTime(input.previewedAt, now);
    const result = await buildDraft(tx, {
      approver: { at: input.previewedAt, name: person.name },
      link: deps.link(proposal.jobId),
      operation: proposal.operation,
      proposalId: proposal.proposalId,
      proposer: { at: new Date(proposal.proposedAt), name: proposal.proposedBy },
      subjectId: proposal.subjectId,
      subjectType: proposal.subjectType as ProposalSubjectType,
    });
    if (!result.ok) throw new ProposalError(result.status, ...result.reasons);
    const { draft } = result;
    const file = draft.mapping.companyFile;
    if (draft.companyFileId !== proposal.companyFileId) {
      throw new ProposalError(409, "This record now belongs to a different MYOB company file. Withdraw this proposal and propose again.");
    }
    if (file.mode !== "write") throw new ProposalError(409, `${file.name} is ${file.mode} for Floorplan. The CFO must set it to read and create first (Admin → MYOB → Entities).`);
    if (draft.payloadHash !== input.payloadHash) throw new ProposalError(409, "The record changed since you previewed it. Preview again.");

    const approved = await updateProposal(tx, proposal.proposalId, proposal.rowVersion, {
      Payload: canonicalJson(draft.payload),
      PayloadHash: draft.payloadHash,
      Rendered: JSON.stringify(draft.rendered),
      ReviewedAt: now,
      ReviewedBy: person.name.slice(0, 200),
      ReviewedByOid: person.oid,
      State: "approved",
    });
    if (!approved) throw new ProposalError(409, "Someone else acted on this proposal since you opened it. Reload.");
    await record(tx, {
      action: "myob.approve",
      actor: person.ledger,
      after: { payloadHash: draft.payloadHash, sentence: draft.rendered.sentence },
      correlationId: proposal.correlationId,
      jobId: proposal.jobId,
      subject: { id: proposal.proposalId, type: "myob_proposal" },
    });
    return approved;
  });
}

function outcomeFields(result: PushResult, proposal: ProposalRow, at: Date): ProposalUpdate | null {
  if (result.kind === "dry_run" || result.kind === "refused") return null;
  if (result.kind === "verified" || result.kind === "differs") {
    return {
      Diff: JSON.stringify(result.diff),
      LastReadBackAt: at,
      MyobError: result.kind === "differs" ? "MYOB holds something different from what was sent: see the diff" : null,
      MyobNumber: String(result.readBack.Number ?? proposal.payload.Number ?? "").slice(0, 30),
      MyobRowVersion: result.readBack.RowVersion == null ? null : String(result.readBack.RowVersion),
      MyobUid: result.uid,
      MyobUrl: myobWebUrl(KIND_OF[proposal.operation], result.uid),
      PushedAt: at,
      ReadBack: JSON.stringify(result.readBack),
      State: result.kind === "verified" ? "verified" : "exception",
    };
  }
  if (result.kind === "changed_in_myob") {
    return { Diff: JSON.stringify(result.diff), MyobError: "Changed in MYOB since Floorplan last saw it: reconcile by hand", State: "exception" };
  }
  if (result.kind === "not_ours" || result.kind === "failed") return { MyobError: result.message.slice(0, 2000), State: "exception" };
  return null;
}

const MESSAGES: Record<PushResult["kind"], string> = {
  changed_in_myob: "Not sent: the record changed in MYOB since Floorplan last saw it. Johanne reconciles the difference by hand.",
  differs: "Sent, but MYOB holds something different from what was sent. See the differences.",
  dry_run: "Dry run: the exact payload is logged and nothing was sent to MYOB.",
  failed: "Not sent.",
  not_ours: "Not sent.",
  refused: "Not sent: Floorplan's MYOB controls don't allow it right now. The proposal stays approved.",
  verified: "Sent to MYOB and read back: it matches.",
};

export async function approveAndSend(deps: SendDeps, person: Person, input: SendInput): Promise<SendOutcome> {
  const approved = await approve(deps, person, input);
  const lastSeen = approved.targetUid ? await deps.withTx((tx) => latestVerifiedForUid(tx, approved.companyFileId, approved.targetUid!)) : null;
  const result = await pushApproved(deps.myob, {
    actor: { kind: "user", name: person.name, oid: person.oid, role: person.ledger.kind === "user" ? person.ledger.role : undefined },
    lastSeen: lastSeen ? { myobRowVersion: lastSeen.myobRowVersion, readBack: lastSeen.readBack } : null,
    proposal: approved,
  });
  const fields = outcomeFields(result, approved, deps.now());
  const detail = "message" in result ? (result as { message: string }).message : "";
  const message = `${MESSAGES[result.kind]} ${detail}`.trim();
  if (!fields) return { message, outcome: result.kind, proposal: approved };

  const finished = await deps.withTx(async (tx) => {
    const current = await getProposal(tx, approved.proposalId, true);
    if (!current) throw new ProposalError(404, "That MYOB proposal disappeared");
    const updated = await updateProposal(tx, current.proposalId, current.rowVersion, fields);
    if (!updated) throw new Error(`MyobProposals ${current.proposalId} changed while its outcome was being recorded`);
    await record(tx, {
      action: result.kind === "verified" ? "myob.push" : "myob.exception",
      actor: person.ledger,
      after: { myobUid: updated.myobUid, outcome: result.kind, state: updated.state },
      correlationId: updated.correlationId,
      jobId: updated.jobId,
      reason: updated.myobError,
      subject: { id: updated.proposalId, type: "myob_proposal" },
    });
    return updated;
  });
  return { message, outcome: result.kind, proposal: finished };
}
