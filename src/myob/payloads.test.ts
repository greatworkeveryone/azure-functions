/// <reference types="jest" />

import { journalMemo, MYOB_TEXT_MAX, orderComment } from "./attribution";
import { myobDocumentDate } from "./darwinClock";
import { canonicalJson, payloadHash } from "./hash";
import { buildServiceDocument, diffDocuments } from "./payloads";
import { formatAud, renderProposal } from "./render";

const NOW = new Date("2026-10-13T23:42:00Z"); // 14/10 09:12 in Darwin
const SUPPLIER = "11111111-2222-4333-8444-555555555555";
const ACCOUNT = "22222222-2222-4333-8444-555555555555";
const GST = "33333333-2222-4333-8444-555555555555";

const order = () =>
  buildServiceDocument({
    comment: "c",
    date: myobDocumentDate(NOW),
    journalMemo: "m",
    kind: "Order",
    lines: [{ accountUid: ACCOUNT, description: "Job #12 · Replace AC compressor", taxCodeUid: GST, total: 4840.004 }],
    number: "66Sm261014",
    supplierUid: SUPPLIER,
  });

describe("buildServiceDocument (Service Order)", () => {
  it("matches the documented shape: Transaction lines with Total, Account and TaxCode; Darwin date; inc GST", () => {
    expect(order()).toEqual({
      Comment: "c",
      Date: "2026-10-14T00:00:00",
      FreightTaxCode: { UID: GST },
      IsTaxInclusive: true,
      JournalMemo: "m",
      Lines: [{ Account: { UID: ACCOUNT }, Description: "Job #12 · Replace AC compressor", TaxCode: { UID: GST }, Total: 4840, Type: "Transaction" }],
      Number: "66Sm261014",
      Supplier: { UID: SUPPLIER },
    });
  });

  it("refuses a number MYOB would reject, and an empty document", () => {
    expect(() => buildServiceDocument({ ...baseFacts(), number: "MAINT-1234-5678" })).toThrow("13 characters");
    expect(() => buildServiceDocument({ ...baseFacts(), lines: [] })).toThrow("at least one line");
  });
});

function baseFacts() {
  return {
    comment: "c", date: "2026-10-14T00:00:00", journalMemo: "m", kind: "Order" as const,
    lines: [{ accountUid: ACCOUNT, description: "x", taxCodeUid: GST, total: 1 }], number: "66Sm261014", supplierUid: SUPPLIER,
  };
}

describe("attribution (decision 13)", () => {
  it("names the proposer and the approver with Darwin stamps", () => {
    const memo = journalMemo({
      approvedAt: new Date("2026-10-14T00:05:00Z"), approvedBy: "Johanne Smith", proposedAt: NOW, proposedBy: "Ray Officer", reference: "66Sm261014",
    });
    expect(memo).toBe("FP 66Sm261014 · proposed Ray Officer 14/10 09:12 · approved Johanne Smith 14/10 09:35");
  });

  it("stays within MYOB's limit by shortening names first, and drops the link before the proposal number", () => {
    const long = "A".repeat(200);
    const a = { approvedAt: NOW, approvedBy: long, link: `https://floorplan.example/${"x".repeat(200)}`, proposalId: 42, proposedAt: NOW, proposedBy: long, reference: "66Sm261014" };
    expect(journalMemo(a).length).toBeLessThanOrEqual(MYOB_TEXT_MAX);
    expect(journalMemo(a)).toContain("approved AAAA");
    const comment = orderComment(a);
    expect(comment.length).toBeLessThanOrEqual(MYOB_TEXT_MAX);
    expect(comment).toContain("proposal #42");
  });
});

describe("hash and bytes", () => {
  it("hashes canonical JSON, so key order can't change the fingerprint", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(payloadHash({ a: 1, b: 2 })).toBe(payloadHash({ b: 2, a: 1 }));
    expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }));
  });
});

describe("read-back diff", () => {
  it("is empty when MYOB holds what was sent (case and line order of UIDs aside), and names a changed amount", () => {
    const sent = order();
    const myob = { ...sent, Lines: [{ ...(sent.Lines as object[])[0], Account: { UID: ACCOUNT.toUpperCase() } }], RowVersion: "9", UID: "x" };
    expect(diffDocuments(sent, myob)).toEqual([]);
    const changed = { ...myob, Lines: [{ ...(myob.Lines as object[])[0], Total: 4900 }] };
    expect(diffDocuments(sent, changed)).toEqual([{ field: "total", myob: 4900, sent: 4840 }]);
  });
});

describe("render (decision 12)", () => {
  it("leads with the one sentence in the CFO's words", () => {
    const rendered = renderProposal({
      account: "6-1234 Repairs", amount: 4840, companyFile: "RP (NT) Pty Ltd", date: "14/10/2026", document: "Order",
      journalMemo: "m", number: "66Sm261013", supplier: "ACME Air Pty Ltd", taxCode: "GST",
    });
    expect(rendered.sentence).toBe(
      "This creates Order 66Sm261013 for $4,840.00 inc GST to ACME Air Pty Ltd in RP (NT) Pty Ltd, dated 14/10/2026. Nothing else in MYOB changes.",
    );
    expect(formatAud(0.5)).toBe("$0.50 inc GST");
  });
});
