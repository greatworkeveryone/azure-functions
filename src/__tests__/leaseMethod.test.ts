/// <reference types="jest" />
// The first describe is copied from command-centre
// src/__tests__/helpers/scheduleImport.test.ts (mapMethodKind): the same cases
// against the backend port. Add a case in both repos or neither. The second
// is backend-only: the legacy RentReviews.ReviewType values the old generator
// copied through, which the review generator now reads with the same function.
import { mapMethodKind } from "../leaseMethod";

describe("mapMethodKind", () => {
  it("maps CPI variants (case-insensitive)", () => {
    expect(mapMethodKind("Dec CPI")).toBe("cpi");
    expect(mapMethodKind("CPI")).toBe("cpi");
    expect(mapMethodKind("cpi june")).toBe("cpi");
    expect(mapMethodKind("CPI Darwin (June)")).toBe("cpi");
  });

  it("maps market variants", () => {
    expect(mapMethodKind("Market Review")).toBe("market");
    expect(mapMethodKind("MARKET RENT REVIEW")).toBe("market");
    expect(mapMethodKind("market")).toBe("market");
  });

  it("maps fixed variants", () => {
    expect(mapMethodKind("Fixed 3%")).toBe("fixed");
    expect(mapMethodKind("Fixed rate")).toBe("fixed");
    expect(mapMethodKind("3%")).toBe("fixed");
  });

  it("maps commencement variants", () => {
    expect(mapMethodKind("Lease commencement")).toBe("commencement");
    expect(mapMethodKind("commencement")).toBe("commencement");
  });

  it("returns null for unrecognised values", () => {
    expect(mapMethodKind("Special arrangement")).toBeNull();
    expect(mapMethodKind("")).toBeNull();
    expect(mapMethodKind("   ")).toBeNull();
  });
});

describe("mapMethodKind on the values the register and the old generator hold", () => {
  it("reads the legacy RentReviews.ReviewType enum", () => {
    expect(mapMethodKind("cpi")).toBe("cpi");
    expect(mapMethodKind("fixedPercent")).toBe("fixed");
    expect(mapMethodKind("marketReview")).toBe("market");
    expect(mapMethodKind("none")).toBeNull();
  });

  it("reads the free-form review types from the tenancy spreadsheet (F5)", () => {
    expect(mapMethodKind("CPI Darwin (June)")).toBe("cpi");
    expect(mapMethodKind("Fixed")).toBe("fixed");
    expect(mapMethodKind("Market on Expiry")).toBe("market");
  });

  it("checks commencement, then CPI, then market, then fixed, as the frontend does", () => {
    expect(mapMethodKind("Fixed or CPI, whichever is higher")).toBe("cpi");
    expect(mapMethodKind("Market (fixed 3% floor)")).toBe("market");
    expect(mapMethodKind("CPI at commencement")).toBe("commencement");
  });
});
