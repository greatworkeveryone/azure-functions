/// <reference types="jest" />
// The basis snapshot taken at commence, and the edits allowed while a review is
// in progress.
import {
  applyBasisPatch,
  buildBasisSnapshot,
  DEFAULT_REVIEW_INTERVAL_MONTHS,
  editableBasisKeys,
  parseBasis,
  validateBasisPatch,
  type BasisSource,
} from "../rentReview/basis";

const lease = (over: Partial<BasisSource> = {}): BasisSource => ({
  cpiCapPercent: 5,
  cpiFloorPercent: 1,
  cpiRegion: "DARWIN",
  fixedReviewPercent: 3,
  intervalMonths: 12,
  method: "cpi",
  ratchet: true,
  reviewDate: "2027-07-01",
  reviewType: "CPI Darwin (June)",
  step: null,
  ...over,
});

describe("buildBasisSnapshot", () => {
  it("snapshots a CPI review: region, reference quarter rule, cap, floor, ratchet, interval", () => {
    expect(buildBasisSnapshot(lease())).toEqual({
      capPercent: 5,
      floorPercent: 1,
      intervalMonths: 12,
      method: "cpi",
      ratchet: true,
      referenceQuarterRule: "quarter_before_review_date",
      region: "DARWIN",
      reviewDate: "2027-07-01",
      reviewType: "CPI Darwin (June)",
    });
  });

  it("snapshots a fixed review with the lease percentage", () => {
    expect(buildBasisSnapshot(lease({ method: "fixed", reviewType: "Fixed 3%" }))).toEqual({
      fixedPercent: 3,
      intervalMonths: 12,
      method: "fixed",
      ratchet: true,
      reviewDate: "2027-07-01",
      reviewType: "Fixed 3%",
    });
  });

  it("takes the fixed % from a fixed step when the tenancy states none", () => {
    const basis = buildBasisSnapshot(
      lease({ fixedReviewPercent: null, method: "fixed", step: { methodKind: "fixed", ratePercent: 4 } }),
    );
    expect(basis.fixedPercent).toBe(4);
    expect(buildBasisSnapshot(lease({ fixedReviewPercent: null, method: "fixed", step: { methodKind: "cpi", ratePercent: 4 } })).fixedPercent).toBeNull();
    expect(buildBasisSnapshot(lease({ fixedReviewPercent: null, method: "fixed" })).fixedPercent).toBeNull();
  });

  it("snapshots a market review with a clause and deadlines to fill in (nothing stores them yet)", () => {
    expect(buildBasisSnapshot(lease({ method: "market", reviewType: "Market on Expiry" }))).toEqual({
      deadlines: [],
      intervalMonths: 12,
      leaseClause: null,
      method: "market",
      ratchet: true,
      reviewDate: "2027-07-01",
      reviewType: "Market on Expiry",
    });
  });

  it("snapshots an other review with a description to fill in", () => {
    const basis = buildBasisSnapshot(lease({ method: "other", reviewType: "Special arrangement" }));
    expect(basis.description).toBeNull();
    expect(basis.method).toBe("other");
  });

  it("assumes the default interval when the lease states none, and keeps only a real region", () => {
    expect(buildBasisSnapshot(lease({ intervalMonths: null })).intervalMonths).toBe(DEFAULT_REVIEW_INTERVAL_MONTHS);
    expect(buildBasisSnapshot(lease({ cpiRegion: "darwin" })).region).toBe("DARWIN");
    expect(buildBasisSnapshot(lease({ cpiRegion: "Sydney" })).region).toBeNull();
    expect(buildBasisSnapshot(lease({ cpiRegion: null })).region).toBeNull();
  });

  it("leaves out nothing the lease states and keeps nulls for what it doesn't", () => {
    const basis = buildBasisSnapshot(lease({ cpiCapPercent: null, cpiFloorPercent: null, reviewType: "  " }));
    expect(basis.capPercent).toBeNull();
    expect(basis.floorPercent).toBeNull();
    expect(basis.reviewType).toBeNull();
  });

  it("is JSON the ISJSON check accepts", () => {
    for (const method of ["cpi", "fixed", "market", "other"] as const) {
      expect(() => JSON.parse(JSON.stringify(buildBasisSnapshot(lease({ method }))))).not.toThrow();
    }
  });
});

describe("validateBasisPatch", () => {
  it("accepts the fields a CPI review lets its owner correct", () => {
    expect(
      validateBasisPatch("cpi", { capPercent: 4.5, floorPercent: null, ratchet: false, referenceQuarterRule: "quarter_before_review_date", region: "AUS" }),
    ).toEqual({
      ok: true,
      patch: { capPercent: 4.5, floorPercent: null, ratchet: false, referenceQuarterRule: "quarter_before_review_date", region: "AUS" },
    });
  });

  it("lists the editable keys per method", () => {
    expect(editableBasisKeys("cpi").sort()).toEqual(["capPercent", "floorPercent", "intervalMonths", "ratchet", "referenceQuarterRule", "region"]);
    expect(editableBasisKeys("fixed").sort()).toEqual(["fixedPercent", "intervalMonths", "ratchet"]);
    expect(editableBasisKeys("market").sort()).toEqual(["deadlines", "intervalMonths", "leaseClause", "ratchet"]);
    expect(editableBasisKeys("other").sort()).toEqual(["description", "intervalMonths", "ratchet"]);
  });

  it("refuses the snapshot's facts and keys that belong to another method", () => {
    for (const key of ["method", "reviewDate", "reviewType"]) {
      expect(validateBasisPatch("cpi", { [key]: "x" })).toMatchObject({ ok: false });
    }
    expect(validateBasisPatch("cpi", { fixedPercent: 3 })).toMatchObject({ ok: false, error: expect.stringContaining("fixedPercent") });
    expect(validateBasisPatch("fixed", { capPercent: 3 })).toMatchObject({ ok: false });
    expect(validateBasisPatch("fixed", { constructor: 1 })).toMatchObject({ ok: false });
  });

  it("refuses an empty or non-object patch", () => {
    for (const raw of [undefined, null, {}, [], "region", 5]) {
      expect(validateBasisPatch("cpi", raw)).toMatchObject({ ok: false });
    }
  });

  it.each([
    ["capPercent", "5"],
    ["capPercent", Number.NaN],
    ["capPercent", 101],
    ["floorPercent", -101],
    ["intervalMonths", 0],
    ["intervalMonths", 12.5],
    ["intervalMonths", 121],
    ["ratchet", "yes"],
    ["region", "SYDNEY"],
    ["referenceQuarterRule", "latest_published"],
  ])("refuses %s = %j on a CPI review", (key, value) => {
    expect(validateBasisPatch("cpi", { [key]: value })).toMatchObject({ ok: false });
  });

  it("checks a fixed percentage, text fields and deadlines", () => {
    expect(validateBasisPatch("fixed", { fixedPercent: 3.25 })).toEqual({ ok: true, patch: { fixedPercent: 3.25 } });
    expect(validateBasisPatch("fixed", { fixedPercent: "3" })).toMatchObject({ ok: false });
    expect(validateBasisPatch("market", { leaseClause: "  Clause 4.2  " })).toEqual({ ok: true, patch: { leaseClause: "Clause 4.2" } });
    expect(validateBasisPatch("market", { leaseClause: "   " })).toEqual({ ok: true, patch: { leaseClause: null } });
    expect(validateBasisPatch("market", { leaseClause: "x".repeat(501) })).toMatchObject({ ok: false });
    expect(validateBasisPatch("other", { description: "x".repeat(2001) })).toMatchObject({ ok: false });
    expect(validateBasisPatch("other", { description: 5 })).toMatchObject({ ok: false });
    expect(validateBasisPatch("market", { deadlines: [{ label: " Notice ", date: "2027-03-31" }] })).toEqual({
      ok: true,
      patch: { deadlines: [{ date: "2027-03-31", label: "Notice" }] },
    });
    for (const deadlines of [
      "soon",
      [{ label: "Notice", date: "31/03/2027" }],
      [{ label: "Notice", date: "2027-02-30" }],
      [{ label: "", date: "2027-03-31" }],
      [{ label: "Notice", date: "2027-03-31", extra: 1 }],
      [null],
      Array.from({ length: 21 }, () => ({ label: "x", date: "2027-03-31" })),
    ]) {
      expect(validateBasisPatch("market", { deadlines })).toMatchObject({ ok: false });
    }
  });
});

describe("applyBasisPatch", () => {
  const current = buildBasisSnapshot(lease());

  it("returns the new basis and only the fields that changed, before and after", () => {
    const result = applyBasisPatch(current, { capPercent: 4, floorPercent: 1, region: "AUS" });
    expect(result).toMatchObject({
      change: {
        after: { capPercent: 4, region: "AUS" },
        before: { capPercent: 5, region: "DARWIN" },
        changed: ["capPercent", "region"],
      },
      ok: true,
    });
    if (result.ok) {
      expect(result.change.basis).toMatchObject({ capPercent: 4, floorPercent: 1, method: "cpi", region: "AUS", reviewDate: "2027-07-01" });
    }
  });

  it("does not mutate the basis it was given", () => {
    const snapshot = JSON.stringify(current);
    applyBasisPatch(current, { capPercent: 4 });
    expect(JSON.stringify(current)).toBe(snapshot);
  });

  it("refuses a patch that changes nothing, so no empty decision is recorded", () => {
    expect(applyBasisPatch(current, { capPercent: 5, region: "DARWIN" })).toEqual({
      error: "That is already the basis; nothing to change",
      kind: "no_change",
      ok: false,
    });
  });

  it("treats a missing key as null, so clearing an unset field changes nothing", () => {
    expect(applyBasisPatch({ method: "cpi" }, { capPercent: null })).toMatchObject({ ok: false });
    const result = applyBasisPatch({ method: "cpi" }, { capPercent: 4 });
    expect(result).toMatchObject({ change: { before: { capPercent: null }, after: { capPercent: 4 } }, ok: true });
  });

  it("will not put the floor above the cap", () => {
    expect(applyBasisPatch(current, { floorPercent: 6 })).toEqual({
      error: "The CPI floor can't be above the cap",
      kind: "invalid",
      ok: false,
    });
    expect(applyBasisPatch(current, { capPercent: 0.5 })).toMatchObject({ ok: false });
    expect(applyBasisPatch(current, { capPercent: null, floorPercent: 6 })).toMatchObject({ ok: true });
  });

  it("compares lists by value", () => {
    const withDeadlines = { ...current, deadlines: [{ date: "2027-03-31", label: "Notice" }] };
    expect(applyBasisPatch(withDeadlines, { deadlines: [{ date: "2027-03-31", label: "Notice" }] })).toMatchObject({ ok: false });
    expect(applyBasisPatch(withDeadlines, { deadlines: [] })).toMatchObject({ change: { changed: ["deadlines"] }, ok: true });
  });
});

describe("parseBasis", () => {
  it("reads a stored basis and nothing else", () => {
    expect(parseBasis('{"method":"cpi"}')).toEqual({ method: "cpi" });
    for (const raw of [null, undefined, "", "  ", "[1]", "5", "not json", 5]) expect(parseBasis(raw)).toBeNull();
  });
});
