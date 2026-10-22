// The Tenancy Schedule's property summary (one building) and portfolio summary
// (every building), from the leases already built. Pure.
//
// Grouped by charge category (TS3, T11), not by label: a licence lease's rent and
// a fee filed under "Licence fee" are one line, and so are car park groups,
// carBayRent fees and a car-bay-only lease's rent ("Car bay rent").

import { FEE_CATEGORIES, LEASE_TYPES, leaseTypeLabel } from "../chargeCategories";
import { money, r2, RENT_RELIEF } from "./charges";
import type { TenancyScheduleChargeKind, TenancyScheduleLease, TenancyScheduleSummary, TenancyScheduleSummaryLine } from "./types";

const KIND_ORDER: Record<TenancyScheduleChargeKind, number> = { rent: 0, ahac: 1, miscFee: 2, carparkGroup: 3, relief: 4 };

// Lines read in this order: plain "Rent" first (every lease reads that until a type
// is set), then the lease types' lines, then the fee categories (a label already
// listed keeps its first place), then relief last. Every category a charge carries
// comes from these lists, so none falls outside them.
const CATEGORY_ORDER: readonly string[] = [
  ...new Set([leaseTypeLabel(null), ...LEASE_TYPES.map((entry) => entry.label), ...FEE_CATEGORIES.map((entry) => entry.label), RENT_RELIEF]),
];
const rankOf = (category: string): number => {
  const rank = CATEGORY_ORDER.indexOf(category);
  return rank === -1 ? CATEGORY_ORDER.length : rank;
};
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export interface SummaryInput {
  bays: TenancyScheduleSummary["bays"];
  leases: readonly TenancyScheduleLease[];
  totalNla: number;
  vacantNla: number;
}

/** Totals per charge category. `kind` is the earliest kind among the group's charges. */
function linesOf(leases: readonly TenancyScheduleLease[], totalNla: number): TenancyScheduleSummaryLine[] {
  const groups = new Map<string, { annual: number; kind: TenancyScheduleChargeKind; label: string }>();
  for (const lease of leases) {
    for (const charge of lease.charges) {
      const label = charge.category.trim();
      const key = label.toLowerCase();
      const group = groups.get(key) ?? { annual: 0, kind: charge.kind, label };
      group.annual = r2(group.annual + charge.annual);
      if (KIND_ORDER[charge.kind] < KIND_ORDER[group.kind]) group.kind = charge.kind;
      groups.set(key, group);
    }
  }
  return [...groups.values()]
    .sort((a, b) => rankOf(a.label) - rankOf(b.label) || collator.compare(a.label, b.label))
    .map((group) => ({ ...money(group.annual, totalNla), kind: group.kind, label: group.label }));
}

export function summarise({ bays, leases, totalNla, vacantNla }: SummaryInput): TenancyScheduleSummary {
  return {
    bays: { ...bays },
    byLabel: linesOf(leases, totalNla),
    leaseCount: leases.length,
    total: money(
      leases.reduce((total, lease) => total + lease.total.annual, 0),
      totalNla,
    ),
    totalNlaSqm: r2(totalNla),
    vacantNlaSqm: r2(vacantNla),
    vacantPercent: totalNla > 0 ? r2((vacantNla / totalNla) * 100) : 0,
  };
}
