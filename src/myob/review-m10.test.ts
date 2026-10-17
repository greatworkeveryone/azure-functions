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
const verdict = (myob: Record<string, unknown>, lastSeen: Record<string, unknown> = MYOB_SAW) =>
  compareReadback({
    floorplanLastTouch: null, kind: "Order", lastSeen, myob, now: new Date("2026-10-14T03:00:00Z"), previousStatus: "Open",
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

  it("sees a line added that isn't a transaction line (only the record diff can)", () => {
    const v = verdict({ ...MYOB_SAW, Lines: [...SENT.Lines, { Description: "Johanne: hold", Type: "Header" }], RowVersion: "8" });
    expect(v.discrepancy?.fields).toEqual([expect.objectContaining({ field: "Lines", floorplan: "1 line", label: "Lines", myob: "2 lines" })]);
    expect(v.advanceVersion).toBe(false);
  });

  it.each([
    ["the freight tax code", { FreightTaxCode: { UID: "t-other" } }, "Freight tax code"],
  ])("sees a change to %s", (_label, edit, label) => {
    const v = verdict({ ...MYOB_SAW, ...edit, RowVersion: "8" });
    expect(v.discrepancy?.fields).toEqual([expect.objectContaining({ label })]);
    expect(v.advanceVersion).toBe(false);
  });

  it("sees a line moved to another job (its Job UID), but not the job being renamed", () => {
    const withJob = (uid: string, name: string) => ({ ...MYOB_SAW, Lines: [{ ...SENT.Lines[0], Job: { Name: name, Number: "J1", UID: uid } }] });
    const moved = verdict({ ...withJob("job-2", "Roof"), RowVersion: "8" }, withJob("job-1", "Roof"));
    expect(moved.discrepancy?.fields).toEqual([expect.objectContaining({ field: "Lines[0].Job.UID", floorplan: "job-1", label: "Line 1 job", myob: "job-2" })]);
    expect(moved.advanceVersion).toBe(false);
    const renamed = verdict({ ...withJob("job-1", "Roof works"), RowVersion: "8" }, withJob("job-1", "Roof"));
    expect(renamed).toMatchObject({ advanceVersion: true, discrepancy: null });
  });

  it("takes the version when only what MYOB manages itself changed", () => {
    const v = verdict({
      ...MYOB_SAW, BalanceDueAmount: 4840, LastModified: "2026-10-14T02:00:00", RowVersion: "8", Supplier: { Name: "ACME Air (renamed)", UID: "s" },
      TotalAmount: 4840, URI: "https://api.myob.com/x",
    });
    expect(v).toMatchObject({ advanceVersion: true, discrepancy: null });
  });
});
