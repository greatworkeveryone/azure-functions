/// <reference types="jest" />
import {
  FEE_CATEGORIES,
  FEE_CATEGORY_ERROR,
  FEE_CATEGORY_VALUES,
  feeCategoryLabel,
  isFeeCategory,
  isLeaseType,
  LEASE_TYPE_ERROR,
  LEASE_TYPE_VALUES,
  LEASE_TYPES,
  leaseTypeLabel,
} from "../chargeCategories";
import { deleteMiscFee, type MiscFee, parseMiscFees, upsertMiscFee, validateMiscFee, validateUpsertFeeEnvelope } from "../scheduledRateStepLogic";

// The lists are pinned literally. The frontend keeps the same table in
// src/constants/chargeCategories.ts and migration 159's CHECK lists the lease
// types: a change here is a change in all three (decision T11).

describe("the lease type and fee category lists (T11)", () => {
  it("pins the lease types, in order, with their labels", () => {
    expect(LEASE_TYPES.map((e) => [e.value, e.label])).toEqual([
      ["retail", "Retail rent"],
      ["office", "Office rent"],
      ["licence", "Licence fee"],
      ["casualMallLicence", "Casual mall licence fee"],
      ["carParkOnly", "Car bay rent"],
      ["other", "Rent"],
    ]);
  });

  it("pins the fee categories, in order, with their labels", () => {
    expect(FEE_CATEGORIES.map((e) => [e.value, e.label])).toEqual([
      ["licenceFee", "Licence fee"],
      ["carBayRent", "Car bay rent"],
      ["afterHoursAc", "After-hours A/C"],
      ["electricity", "Electricity"],
      ["cleaning", "Cleaning"],
      ["outgoings", "Outgoings"],
      ["promotionFund", "Promotion fund"],
      ["other", "Other charges"],
    ]);
  });

  it("keeps the values within the column and the stored JSON, and each list free of duplicates", () => {
    for (const value of [...LEASE_TYPE_VALUES, ...FEE_CATEGORY_VALUES]) expect(value.length).toBeLessThanOrEqual(30);
    expect(new Set(LEASE_TYPE_VALUES).size).toBe(LEASE_TYPE_VALUES.length);
    expect(new Set(FEE_CATEGORY_VALUES).size).toBe(FEE_CATEGORY_VALUES.length);
  });
});

describe("type guards and labels", () => {
  it.each([...LEASE_TYPE_VALUES])("accepts the lease type %s", (value) => {
    expect(isLeaseType(value)).toBe(true);
  });
  it.each([["freehold"], [""], [null], [undefined], [3], ["Retail"], ["carBayRent"]])("refuses %p as a lease type", (value) => {
    expect(isLeaseType(value)).toBe(false);
  });
  it.each([...FEE_CATEGORY_VALUES])("accepts the fee category %s", (value) => {
    expect(isFeeCategory(value)).toBe(true);
  });
  it.each([["rent"], [""], [null], [undefined], [3], ["Cleaning"], ["retail"]])("refuses %p as a fee category", (value) => {
    expect(isFeeCategory(value)).toBe(false);
  });

  it("looks labels up, with Rent for an unset lease type and Other charges for an unset category", () => {
    expect(leaseTypeLabel("casualMallLicence")).toBe("Casual mall licence fee");
    expect(leaseTypeLabel("other")).toBe("Rent");
    expect(leaseTypeLabel(null)).toBe("Rent");
    expect(feeCategoryLabel("promotionFund")).toBe("Promotion fund");
    expect(feeCategoryLabel("other")).toBe("Other charges");
    expect(feeCategoryLabel(undefined)).toBe("Other charges");
  });

  it("names the allowed values in the 400 messages", () => {
    expect(LEASE_TYPE_ERROR).toBe("LeaseType must be one of retail, office, licence, casualMallLicence, carParkOnly, other, or null");
    expect(FEE_CATEGORY_ERROR).toBe(
      "fee.category must be one of licenceFee, carBayRent, afterHoursAc, electricity, cleaning, outgoings, promotionFund, other, or null",
    );
  });
});

describe("a misc fee's category (TS3)", () => {
  const ID = "00000000-0000-4000-8000-000000000901";
  const fee: MiscFee = { baseAmount: 100, commencedAt: "2025-01-01", frequency: "monthly", id: ID, title: "Cleaning" };

  it.each([...FEE_CATEGORY_VALUES])("validates and keeps the category %s", (category) => {
    const result = validateMiscFee({ ...fee, category });
    expect(result).toEqual({ fee: { ...fee, category }, ok: true });
  });

  it.each([["rent"], [""], [3], ["Cleaning"], [false]])("refuses %p as a category", (category) => {
    expect(validateMiscFee({ ...fee, category })).toEqual({ error: FEE_CATEGORY_ERROR, ok: false });
    expect(validateUpsertFeeEnvelope({ BuildingId: 5, TenantId: 1, fee: { ...fee, category } })).toEqual({ error: FEE_CATEGORY_ERROR, ok: false });
  });

  it("treats an omitted or null category as uncategorised, and stores no key for it", () => {
    expect(validateMiscFee(fee)).toEqual({ fee, ok: true });
    const cleared = validateMiscFee({ ...fee, category: null });
    expect(cleared).toEqual({ fee, ok: true });
    expect("category" in (cleared as { fee: object }).fee).toBe(false);
  });

  it("still refuses an unknown key on a fee", () => {
    expect(validateMiscFee({ ...fee, categroy: "cleaning" })).toMatchObject({ ok: false });
  });

  it("survives the stored JSON: parse keeps the category and the rest of the fee, serialise writes it", () => {
    const withSteps = { ...fee, category: "outgoings", endsAt: "2030-01-01", note: "n", rateSteps: [{ effectiveFrom: "2026-01-01", id: "00000000-0000-4000-8000-000000000951", newAmount: 120 }] };
    const stored = JSON.stringify([withSteps, { ...fee, id: "00000000-0000-4000-8000-000000000902", title: "Plain" }]);
    const parsed = parseMiscFees(stored);
    expect(parsed).toEqual([withSteps, { ...fee, id: "00000000-0000-4000-8000-000000000902", title: "Plain" }]);
    expect(parseMiscFees(JSON.stringify(parsed))).toEqual(parsed);
  });

  it("drops a stored category that is off the list when parsing, rather than passing it on", () => {
    expect(parseMiscFees(JSON.stringify([{ ...fee, category: "bogus" }]))).toEqual([fee]);
  });

  it("round-trips through upsert: add, change the category, clear it, and delete leaves the others' categories", () => {
    const other = { ...fee, category: "electricity" as const, id: "00000000-0000-4000-8000-000000000902", title: "Power" };
    const added = upsertMiscFee([other], { ...fee, category: "cleaning" });
    expect(parseMiscFees(JSON.stringify(added)).map((f) => f.category)).toEqual(["electricity", "cleaning"]);
    const changed = upsertMiscFee(added, { ...fee, category: "outgoings" });
    expect(changed.map((f) => f.category)).toEqual(["electricity", "outgoings"]);
    const cleared = upsertMiscFee(changed, fee);
    expect(cleared.map((f) => f.category)).toEqual(["electricity", undefined]);
    expect(deleteMiscFee(cleared, ID)).toEqual([other]);
  });
});
