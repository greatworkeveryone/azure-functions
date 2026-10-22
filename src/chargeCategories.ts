// Lease types and fee categories (Tenancy Schedule TS3, decision T11 in
// command-centre .harness/TENANCY-SCHEDULE-REPORT-2026-10-22.md).
//
// The frontend keeps the same table in src/constants/chargeCategories.ts
// (LEASE_TYPES, FEE_CATEGORIES, label lookups). Change both: the frontend copy
// explains, this one enforces. Migration 159's CHECK constraint on
// Tenants.LeaseType lists the same lease type values. WP29b's billing line
// types will reuse FEE_CATEGORIES, so there is one taxonomy, not two.
//
// Neither list changes a figure: they are labels on a tenancy and on a charge.

export interface ChargeCategoryEntry<V extends string> {
  label: string;
  value: V;
}

export const LEASE_TYPES = [
  { label: "Retail rent", value: "retail" },
  { label: "Office rent", value: "office" },
  { label: "Licence fee", value: "licence" },
  { label: "Casual mall licence fee", value: "casualMallLicence" },
  { label: "Car bay rent", value: "carParkOnly" },
  { label: "Rent", value: "other" },
] as const satisfies readonly ChargeCategoryEntry<string>[];

export const FEE_CATEGORIES = [
  { label: "Licence fee", value: "licenceFee" },
  { label: "Car bay rent", value: "carBayRent" },
  { label: "After-hours A/C", value: "afterHoursAc" },
  { label: "Electricity", value: "electricity" },
  { label: "Cleaning", value: "cleaning" },
  { label: "Outgoings", value: "outgoings" },
  { label: "Promotion fund", value: "promotionFund" },
  { label: "Other charges", value: "other" },
] as const satisfies readonly ChargeCategoryEntry<string>[];

export type LeaseType = (typeof LEASE_TYPES)[number]["value"];
export type FeeCategory = (typeof FEE_CATEGORIES)[number]["value"];

export const LEASE_TYPE_VALUES: readonly LeaseType[] = LEASE_TYPES.map((entry) => entry.value);
export const FEE_CATEGORY_VALUES: readonly FeeCategory[] = FEE_CATEGORIES.map((entry) => entry.value);

export const isLeaseType = (value: unknown): value is LeaseType => typeof value === "string" && (LEASE_TYPE_VALUES as readonly string[]).includes(value);
export const isFeeCategory = (value: unknown): value is FeeCategory => typeof value === "string" && (FEE_CATEGORY_VALUES as readonly string[]).includes(value);

/** The rent line's label and summary group for a lease type; "Rent" when it isn't set (the same as `other`). */
export const leaseTypeLabel = (value: LeaseType | null | undefined): string => LEASE_TYPES.find((entry) => entry.value === value)?.label ?? "Rent";

/** A fee category's label; "Other charges" when unset. */
export const feeCategoryLabel = (value: FeeCategory | null | undefined): string => FEE_CATEGORIES.find((entry) => entry.value === value)?.label ?? "Other charges";

/** The error text for a lease type outside the list (a 400 on upsertRegisterTenant). */
export const LEASE_TYPE_ERROR = `LeaseType must be one of ${LEASE_TYPE_VALUES.join(", ")}, or null`;
/** The error text for a fee category outside the list (a 400 on upsertMiscFee). */
export const FEE_CATEGORY_ERROR = `fee.category must be one of ${FEE_CATEGORY_VALUES.join(", ")}, or null`;
