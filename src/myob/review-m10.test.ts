/// <reference types="jest" />

// The M10 reviewer's scenarios (17 Oct), kept in the suite: a hand edit in
// MYOB to something Floorplan writes, outside the headline fields, must be a
// discrepancy and must keep MYOB's new row version out, so the next "Update in
// MYOB" is refused instead of overwriting the edit (decision 11).

import { compareReadback } from "./readbackCompare";

const SENT = {
  Comment: "FP 66Sm261014 · proposed Ray 14/10 09:00 · approved Johanne 14/10 09:10 · proposal #5",
  Date: "2026-10-14T00:00:00",
  FreightTaxCode: { UID: "t" },
  IsTaxInclusive: true,
  JournalMemo: "FP 66Sm261014 · proposed Ray 14/10 09:00 · approved Johanne 14/10 09:10",
  Lines: [{ Account: { UID: "a" }, Description: "66Sm261014 · Floorplan job #12", TaxCode: { UID: "t" }, Total: 4840, Type: "Transaction" }],
  Number: "66Sm261014",
  Supplier: { UID: "s" },
};
const MYOB_SAW = { ...SENT, RowVersion: "7", Status: "Open" };
const verdict = (myob: Record<string, unknown>) =>
  compareReadback({
    floorplanLastTouch: null, kind: "Order", lastSeen: MYOB_SAW, myob, now: new Date("2026-10-14T03:00:00Z"), previousStatus: "Open",
    sent: SENT, sentLabels: { supplier: "ACME" },
  });

describe("a hand edit in MYOB to something Floorplan writes, outside the headline fields", () => {
  it.each([
    ["IsTaxInclusive flipped (same line total, 10% more money)", { IsTaxInclusive: false }, "Tax inclusive"],
    ["line description rewritten", { Lines: [{ ...SENT.Lines[0], Description: "Johanne: hold, disputed" }] }, "Line 1 description"],
    ["memo rewritten", { JournalMemo: "Johanne: do not pay" }, "Memo"],
    ["comment rewritten", { Comment: "Johanne: duplicate of 00001234" }, "Comment"],
    ["promised date added", { PromisedDate: "2026-10-30T00:00:00" }, "Promised date"],
  ])("%s: a discrepancy, and MYOB's version is not taken", (_label, edit, label) => {
    const v = verdict({ ...MYOB_SAW, ...edit, RowVersion: "8" });
    expect(v.discrepancy?.fields).toEqual([expect.objectContaining({ label })]);
    expect(v.advanceVersion).toBe(false);
  });

  it("takes the version when only what MYOB manages itself changed", () => {
    const v = verdict({
      ...MYOB_SAW, BalanceDueAmount: 4840, LastModified: "2026-10-14T02:00:00", RowVersion: "8", Supplier: { Name: "ACME Air (renamed)", UID: "s" },
      TotalAmount: 4840, URI: "https://api.myob.com/x",
    });
    expect(v).toMatchObject({ advanceVersion: true, discrepancy: null });
  });
});
