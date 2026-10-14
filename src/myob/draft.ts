// A MYOB proposal's exact payload, its hash and its rendering, built from
// Floorplan's records and the CFO's mappings. The same function builds the
// preview a person sees and the payload that is checked again at the click,
// so a record that changed in between is caught by the hash (decision 12).
//
//   create  a new Service Quote / Order, dated today in Darwin
//   update  the Floorplan-created record, keeping its MYOB date; only when
//           Floorplan holds a verified copy of it to compare with

import type { Connection } from "tedious";
import { journalMemo, orderComment } from "./attribution";
import { darwinDisplayDate, myobDocumentDate } from "./darwinClock";
import { payloadHash, sha256Hex } from "./hash";
import { resolveMapping, type ResolvedMapping } from "./mappings";
import { BILLS_ENABLED, buildServiceDocument, comparable, MYOB_NUMBER_MAX, type MyobDocumentKind } from "./payloads";
import { latestVerifiedForUid, proposalsForSubject, type ProposalOperation } from "./proposalsStore";
import { formatAud, renderProposal, type RenderedProposal } from "./render";
import { loadSubject, type ProposalSubjectType, type SubjectFacts } from "./subjects";

export interface DraftInput {
  approver?: { at: Date; name: string } | null;
  link?: string | null;
  operation: ProposalOperation;
  proposalId?: number | null;
  proposer: { at: Date; name: string };
  subjectId: number;
  subjectType: ProposalSubjectType;
}

export interface Draft {
  companyFileId: string;
  facts: SubjectFacts;
  idempotencyKey: string;
  mapping: ResolvedMapping;
  payload: Record<string, unknown>;
  payloadHash: string;
  rendered: RenderedProposal;
  /** For an update: the Floorplan-created MYOB record and the row version Floorplan last saw. */
  target: { myobRowVersion: string | null; uid: string } | null;
}

export type DraftResult = { ok: true; draft: Draft } | { ok: false; reasons: string[]; status: 404 | 409 };

const OPERATIONS: Record<ProposalSubjectType, { create: ProposalOperation; kind: MyobDocumentKind; update: ProposalOperation }> = {
  purchase_order: { create: "orders.create", kind: "Order", update: "orders.update" },
  quote: { create: "quotes.create", kind: "Quote", update: "quotes.update" },
};

const refuse = (status: 404 | 409, ...reasons: string[]): DraftResult => ({ ok: false, reasons, status });

export async function buildDraft(connection: Connection, input: DraftInput): Promise<DraftResult> {
  if (input.operation === "bills.create" && !BILLS_ENABLED) {
    return refuse(409, "Bills stay off until the CFO approves how an order becomes a bill (Appendix B)");
  }
  const kinds = OPERATIONS[input.subjectType];
  const isUpdate = input.operation === kinds.update;
  if (!kinds || (input.operation !== kinds.create && !isUpdate)) return refuse(409, `${input.operation} doesn't apply to a ${input.subjectType}`);

  const facts = await loadSubject(connection, input.subjectType, input.subjectId);
  if (!facts) return refuse(404, "That record no longer exists");
  if (facts.notReady) return refuse(409, facts.notReady);
  if (facts.reference && facts.reference.length > MYOB_NUMBER_MAX) {
    return refuse(409, `Reference code missing: ${facts.reference} is longer than MYOB's ${MYOB_NUMBER_MAX} characters. Ask Johanne for the building's code.`);
  }
  const mapped = await resolveMapping(connection, facts);
  if (!mapped.ok) return refuse(409, ...mapped.reasons);
  const mapping = mapped.value;

  let target: Draft["target"] = null;
  let lastSeen: Record<string, unknown> | null = null;
  let date = myobDocumentDate(input.approver?.at ?? input.proposer.at);
  if (isUpdate) {
    const created = (await proposalsForSubject(connection, input.subjectType, input.subjectId)).find(
      (row) => row.operation === kinds.create && row.state === "verified" && row.myobUid,
    );
    if (!created?.myobUid) return refuse(409, "Floorplan hasn't created this record in MYOB, so it can't update it");
    const seen = await latestVerifiedForUid(connection, created.companyFileId, created.myobUid);
    target = { myobRowVersion: seen?.myobRowVersion ?? null, uid: created.myobUid };
    lastSeen = seen?.readBack ?? created.readBack ?? created.payload;
    date = String(lastSeen.Date ?? created.payload.Date);
  }

  const attribution = {
    approvedAt: input.approver?.at ?? null,
    approvedBy: input.approver?.name ?? null,
    link: input.link ?? null,
    proposalId: input.proposalId ?? null,
    proposedAt: input.proposer.at,
    proposedBy: input.proposer.name,
    reference: facts.reference ?? "",
  };
  const payload = buildServiceDocument({
    comment: orderComment(attribution),
    date,
    journalMemo: journalMemo(attribution),
    kind: kinds.kind,
    lines: [{ accountUid: mapping.account.uid, description: facts.description, taxCodeUid: mapping.taxCode.uid, total: facts.amount ?? 0 }],
    number: facts.reference ?? "",
    supplierUid: mapping.supplier.uid,
  });
  const hash = payloadHash(payload);

  const rendered = renderProposal({
    account: mapping.account.label,
    amount: facts.amount ?? 0,
    companyFile: mapping.companyFile.name,
    date: darwinDisplayDate(new Date(`${date.slice(0, 10)}T00:00:00+09:30`)),
    document: kinds.kind,
    journalMemo: String(payload.JournalMemo),
    number: facts.reference ?? "",
    supplier: mapping.supplier.name,
    taxCode: mapping.taxCode.code,
    ...(isUpdate ? { update: { changes: describeUpdate(lastSeen ?? {}, payload) } } : {}),
  });

  return {
    draft: {
      companyFileId: mapping.companyFile.id,
      facts,
      idempotencyKey: sha256Hex(`${input.operation}|${input.subjectType}:${input.subjectId}|${hash}`),
      mapping,
      payload,
      payloadHash: hash,
      rendered,
      target,
    },
    ok: true,
  };
}

/** Before → after in the CFO's terms: what Floorplan last saw in MYOB against what it would send now. */
export function describeUpdate(
  lastSeen: Record<string, unknown>,
  payload: Record<string, unknown>,
): { after: string; before: string; field: string }[] {
  const before = comparable(lastSeen);
  const after = comparable(payload);
  const out: { after: string; before: string; field: string }[] = [];
  if (before.total !== after.total) out.push({ after: formatAud(after.total), before: formatAud(before.total), field: "Amount" });
  if (before.supplierUid !== after.supplierUid) out.push({ after: "the newly mapped supplier", before: "the supplier on the record", field: "Supplier" });
  if (JSON.stringify(before.accountUids) !== JSON.stringify(after.accountUids)) {
    out.push({ after: "the newly mapped account", before: "the account on the record", field: "Account" });
  }
  return out;
}
