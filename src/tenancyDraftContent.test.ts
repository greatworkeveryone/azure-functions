import { draftContents, tenancyRowForLedger } from "./tenancyDraftContent";

// The rule's behaviour column by column is covered through the delete routes
// (src/functions/tenancyArchive.test.ts); this holds what is only about wording.
describe("draftContents", () => {
  it("is empty for a row with nothing a person entered", () => {
    expect(draftContents({ ReviewType: "none", ReviewRatchet: false, LegalName: "Acme", Status: "current", Comments: null })).toEqual([]);
  });

  it("counts a list's entries that have something in them, not its blank ones", () => {
    expect(draftContents({ InfoSheetSections: '[{}, {"id":"a"}, {"id":"b"}]' })).toEqual(["2 lease clause sections"]);
    expect(draftContents({ MiscFees: '[{"id":"a"}]' })).toEqual(["1 miscellaneous fee"]);
  });

  it("says a list it can't count in words without a count", () => {
    expect(draftContents({ InfoSheetSections: '{"id":"a"}' })).toEqual(["lease clauses"]);
    expect(draftContents({ Incentives: "[broken" })).toEqual(["incentives"]);
  });

  it("names columns that share a label once, in the list's order", () => {
    expect(draftContents({ Abn: "1", Comments: "x", TradingName: "Acme" })).toEqual(["comments", "company details"]);
  });

  it("keeps 0 and true as something: a figure typed as 0 was still typed", () => {
    expect(draftContents({ RentPerAnnum: 0 })).toEqual(["rent figures"]);
    expect(draftContents({ ReviewRatchet: true })).toEqual(["rent review settings"]);
  });
});

describe("tenancyRowForLedger", () => {
  it("makes the row JSON-safe and keeps every column", () => {
    const row = { Commencement: new Date("2026-11-01T00:00:00Z"), LegalName: "Acme", MyobId: null, RowVersion: Buffer.from("00000000000001", "hex") };
    expect(tenancyRowForLedger(row)).toEqual({ Commencement: "2026-11-01T00:00:00.000Z", LegalName: "Acme", MyobId: null, RowVersion: "00000000000001" });
  });
});
