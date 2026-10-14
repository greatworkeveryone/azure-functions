// A MYOB proposal in the CFO's words: what will be created, for how much, to
// whom, in which company file, on which date, and the one sentence the
// preview leads with (decision 12): "This creates Order 66Sm261013 for
// $4,840.00 inc GST to ACME Air Pty Ltd in RP (NT) Pty Ltd, dated 14/10/2026.
// Nothing else in MYOB changes."

import type { MyobDocumentKind } from "./payloads";

export interface RenderedProposal {
  account: string;
  amount: string;
  companyFile: string;
  date: string;
  document: MyobDocumentKind;
  journalMemo: string;
  number: string;
  sentence: string;
  supplier: string;
  taxCode: string;
  /** For an update: what changes, before → after. */
  changes?: { after: string; before: string; field: string }[];
}

const AUD = new Intl.NumberFormat("en-AU", { currency: "AUD", minimumFractionDigits: 2, style: "currency" });

export function formatAud(amount: number): string {
  return `${AUD.format(amount)} inc GST`;
}

export function renderProposal(input: {
  account: string;
  amount: number;
  companyFile: string;
  date: string;
  document: MyobDocumentKind;
  journalMemo: string;
  number: string;
  supplier: string;
  taxCode: string;
  update?: { changes: { after: string; before: string; field: string }[] };
}): RenderedProposal {
  const amount = formatAud(input.amount);
  const sentence = input.update
    ? `This updates ${input.document} ${input.number} in ${input.companyFile}: ${
        input.update.changes.map((c) => `${c.field} ${c.before} → ${c.after}`).join("; ") || "no field changes"
      }. Nothing else in MYOB changes.`
    : `This creates ${input.document} ${input.number} for ${amount} to ${input.supplier} in ${input.companyFile}, dated ${input.date}. Nothing else in MYOB changes.`;
  return {
    account: input.account,
    amount,
    ...(input.update ? { changes: input.update.changes } : {}),
    companyFile: input.companyFile,
    date: input.date,
    document: input.document,
    journalMemo: input.journalMemo,
    number: input.number,
    sentence,
    supplier: input.supplier,
    taxCode: input.taxCode,
  };
}
