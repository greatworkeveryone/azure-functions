// GST basis of a tenancy's rents and fees (decision T14 in command-centre
// .harness/TENANCY-SCHEDULE-REPORT-2026-10-22.md).
//
// Staff choose per tenancy whether the figures they enter are ex GST or inc
// GST. Floorplan never converts between the two: the basis is a label that every
// money figure for the tenancy carries. The frontend keeps the same table in
// src/constants/gstBasis.ts. Change both. Migration 160's CHECK constraint on
// Tenants.GstBasis lists the same values.

export const GST_BASES = ["ex", "inc"] as const;

export type GstBasis = (typeof GST_BASES)[number];

export const isGstBasis = (value: unknown): value is GstBasis => typeof value === "string" && (GST_BASES as readonly string[]).includes(value);

/** The error text for a basis outside the list (a 400 on upsertRegisterTenant). */
export const GST_BASIS_ERROR = `GstBasis must be one of ${GST_BASES.join(", ")}, or null`;

/** What a group of leases reports: "ex" or "inc" when every lease has that basis, "mixed" when they differ (a lease with none recorded differs from one with a basis, so a figure is never called ex or inc when it may not be), "unknown" when none is recorded. */
export type GstBasisSummary = GstBasis | "mixed" | "unknown";

export function summariseGstBasis(bases: readonly (GstBasis | null)[]): GstBasisSummary {
  const distinct = new Set(bases);
  if (distinct.size > 1) return "mixed";
  const only = [...distinct][0];
  return only ?? "unknown";
}
