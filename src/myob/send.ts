// "Approve and send to MYOB" (decision 12). Three steps, so a MYOB call never
// runs inside a database transaction and nothing is marked sent before MYOB
// has said so:
//   1. approve (transaction): the CFO, not the proposer when review is on; the
//      demonstration file only (no production writes this sprint); the record
//      still what was proposed; the preview hash equal to the payload rebuilt
//      now with her as approver; then state pushed, the final payload stored,
//      ledgered myob.approve. "pushed" is set here, before any MYOB call, so a
//      second click (another tab, a reload) is refused while this one runs
//   2. push (no transaction): sendSteps.ts
//   3. record (transaction): sendOutcome.ts; a refusal inside Floorplan
//      (controls off, dry run, master switch, period rule) returns the
//      proposal to approved, to be sent again once allowed
// A push still marked pushed after PUSH_STALE_MS (pushState.ts) can't be
// running and may be sent again: the lookup by number links the record if the
// first try created it.

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery } from "../db";
import { record } from "../ledger";
import { buildDraft } from "./draft";
import { canonicalJson } from "./hash";
import type { Person } from "./propose";
import { checkPreviewTime, ProposalError } from "./proposalErrors";
import { proposalDrift } from "./payloads";
import { pushInFlight } from "./pushState";
import { getProposal, latestVerifiedForUid, updateProposal, type ProposalRow } from "./proposalsStore";
import { outcomeAction, outcomeFields, outcomeMessage } from "./sendOutcome";
import { pushApproved, type MyobPurchases, type PushResult } from "./sendSteps";
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

const SENDABLE = new Set(["proposed", "approved", "exception", "pushed"]);
const samePerson = (proposal: ProposalRow, person: Person) =>
  proposal.proposedByOid ? proposal.proposedByOid === person.oid : proposal.proposedBy === person.name;

async function reviewRequired(tx: Connection, proposal: ProposalRow): Promise<boolean> {
  const rows = await executeQuery(tx, `SELECT RequireReview FROM dbo.MyobControls WHERE CompanyFileId = @CompanyFileId AND Operation = @Operation`, [
    { name: "CompanyFileId", type: TYPES.NVarChar, value: proposal.companyFileId },
    { name: "Operation", type: TYPES.NVarChar, value: proposal.operation },
  ]);
  return rows[0] ? Boolean(rows[0].RequireReview) : true;
}

/** Decision 7: until D9's test-data check and S11's money gate are wired into this path, only the demonstration file. */
async function refuseUnlessDemonstration(tx: Connection, companyFileId: string): Promise<void> {
  const rows = await executeQuery(tx, `SELECT Name, IsDemonstration FROM dbo.MyobCompanyFiles WHERE CompanyFileId = @CompanyFileId`, [
    { name: "CompanyFileId", type: TYPES.NVarChar, value: companyFileId },
  ]);
  if (rows[0]?.IsDemonstration === true) return;
  const name = typeof rows[0]?.Name === "string" && rows[0].Name ? rows[0].Name : "This company file";
  throw new ProposalError(
    409,
    `${name} isn't flagged as the demonstration file. Floorplan sends only to the demonstration file until the test-data check and the money gate cover MYOB.`,
  );
}

async function approve(deps: SendDeps, person: Person, input: SendInput): Promise<ProposalRow> {
  const now = deps.now();
  return deps.withTx(async (tx) => {
    const proposal = await getProposal(tx, input.proposalId, true);
    if (!proposal) throw new ProposalError(404, "That MYOB proposal doesn't exist");
    if (!SENDABLE.has(proposal.state)) throw new ProposalError(409, `This proposal is ${proposal.state}; there is nothing to send.`);
    if (pushInFlight(proposal, now)) throw new ProposalError(409, "This proposal is being sent to MYOB now. Reload in a minute to see what MYOB said.");
    if (proposal.rowVersion !== input.expectedRowVersion) throw new ProposalError(409, "Someone else acted on this proposal since you opened it. Reload.");
    if ((await reviewRequired(tx, proposal)) && samePerson(proposal, person)) {
      throw new ProposalError(403, "A second person must approve this: you proposed it.");
    }
    await refuseUnlessDemonstration(tx, proposal.companyFileId);
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
    const drift = proposalDrift(proposal.payload, draft.payload);
    if (drift.length > 0) {
      throw new ProposalError(409, `This record changed since it was proposed: withdraw and propose again. What changed: ${drift.join(", ")}.`);
    }
    if (draft.payloadHash !== input.payloadHash) throw new ProposalError(409, "The record changed since you previewed it. Preview again.");

    const approved = await updateProposal(tx, proposal.proposalId, proposal.rowVersion, {
      Payload: canonicalJson(draft.payload),
      PayloadHash: draft.payloadHash,
      PushedAt: now,
      Rendered: JSON.stringify(draft.rendered),
      ReviewedAt: now,
      ReviewedBy: person.name.slice(0, 200),
      ReviewedByOid: person.oid,
      State: "pushed",
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

export async function approveAndSend(deps: SendDeps, person: Person, input: SendInput): Promise<SendOutcome> {
  const approved = await approve(deps, person, input);
  const lastSeen = approved.targetUid ? await deps.withTx((tx) => latestVerifiedForUid(tx, approved.companyFileId, approved.targetUid!)) : null;
  const result = await pushApproved(deps.myob, {
    actor: { kind: "user", name: person.name, oid: person.oid, role: person.ledger.kind === "user" ? person.ledger.role : undefined },
    lastSeen: lastSeen ? { myobRowVersion: lastSeen.myobRowVersion, readBack: lastSeen.readBack } : null,
    proposal: approved,
  });
  const fields = outcomeFields(result, approved, deps.now());
  const action = outcomeAction(result);
  const message = outcomeMessage(result);

  const finished = await deps.withTx(async (tx) => {
    const current = await getProposal(tx, approved.proposalId, true);
    if (!current) throw new ProposalError(404, "That MYOB proposal disappeared");
    const updated = await updateProposal(tx, current.proposalId, current.rowVersion, fields);
    if (!updated) throw new Error(`MyobProposals ${current.proposalId} changed while its outcome was being recorded`);
    if (!action) return updated;
    await record(tx, {
      action,
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
