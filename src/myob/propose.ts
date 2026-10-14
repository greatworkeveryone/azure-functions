// "Propose to MYOB" and "Update in MYOB" (decision 12): a person asks for one
// record to be created or updated in MYOB. Nothing is sent: the proposal waits
// for the CFO's "Approve and send". The click must carry the hash of the
// preview the person saw; if the record changed since, the hashes differ and
// nothing is proposed. One open proposal per record and operation.

import type { Connection } from "tedious";
import { record, type LedgerActor } from "../ledger";
import { buildDraft } from "./draft";
import { checkPreviewTime, ProposalError } from "./proposalErrors";
import { insertProposal, proposalsForSubject, type ProposalOperation, type ProposalRow } from "./proposalsStore";
import type { ProposalSubjectType } from "./subjects";

export interface ProposeInput {
  operation: ProposalOperation;
  payloadHash: string;
  previewedAt: Date;
  subjectId: number;
  subjectType: ProposalSubjectType;
}

export interface Person {
  ledger: LedgerActor;
  name: string;
  oid: string;
}

const OPEN = new Set(["proposed", "approved"]);

export async function propose(tx: Connection, person: Person, input: ProposeInput, correlationId: string, now: Date): Promise<ProposalRow> {
  checkPreviewTime(input.previewedAt, now);
  const result = await buildDraft(tx, {
    operation: input.operation,
    proposer: { at: input.previewedAt, name: person.name },
    subjectId: input.subjectId,
    subjectType: input.subjectType,
  });
  if (!result.ok) throw new ProposalError(result.status, ...result.reasons);
  const { draft } = result;
  const file = draft.mapping.companyFile;
  if (file.mode === "off") throw new ProposalError(409, `${file.name} is off for Floorplan. Ask the CFO to switch it on (Admin → MYOB → Entities).`);
  if (draft.payloadHash !== input.payloadHash) throw new ProposalError(409, "The record changed since you previewed it. Preview again.");

  const existing = await proposalsForSubject(tx, input.subjectType, input.subjectId);
  if (existing.some((row) => row.operation === input.operation && OPEN.has(row.state))) {
    throw new ProposalError(409, "There is already an open MYOB proposal for this record.");
  }

  const row = await insertProposal(tx, {
    companyFileId: draft.companyFileId,
    correlationId,
    idempotencyKey: draft.idempotencyKey,
    jobId: draft.facts.jobId,
    operation: input.operation,
    payload: draft.payload,
    payloadHash: draft.payloadHash,
    proposedAt: input.previewedAt,
    proposedBy: person.name,
    proposedByOid: person.oid,
    rendered: draft.rendered,
    subjectId: input.subjectId,
    subjectType: input.subjectType,
    targetUid: draft.target?.uid ?? null,
  });
  await record(tx, {
    action: "myob.propose",
    actor: person.ledger,
    after: { companyFile: file.name, number: draft.rendered.number, operation: input.operation, payloadHash: draft.payloadHash, sentence: draft.rendered.sentence },
    correlationId,
    jobId: draft.facts.jobId,
    subject: { id: row.proposalId, type: "myob_proposal" },
  });
  return row;
}
