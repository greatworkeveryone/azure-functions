// The Tenancy Schedule's property summary (one building) and portfolio summary
// (every building), from the leases already built. Pure.

import { money, r2 } from "./charges";
import type { TenancyScheduleChargeKind, TenancyScheduleLease, TenancyScheduleSummary, TenancyScheduleSummaryLine } from "./types";

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

const KIND_ORDER: Record<TenancyScheduleChargeKind, number> = { rent: 0, ahac: 1, miscFee: 2, carparkGroup: 3, relief: 4 };
const FIXED_LABEL: Partial<Record<TenancyScheduleChargeKind, string>> = {
  ahac: "After-hours A/C",
  carparkGroup: "Car parks",
  relief: "Rent relief",
  rent: "Rent",
};

export interface SummaryInput {
  bays: TenancyScheduleSummary["bays"];
  leases: readonly TenancyScheduleLease[];
  totalNla: number;
  vacantNla: number;
}

/** Totals per kind of charge; misc fees by title (trimmed, case-insensitive), the title as first written. */
function linesOf(leases: readonly TenancyScheduleLease[], totalNla: number): TenancyScheduleSummaryLine[] {
  const groups = new Map<string, { annual: number; kind: TenancyScheduleChargeKind; label: string }>();
  for (const lease of leases) {
    for (const charge of lease.charges) {
      const label = FIXED_LABEL[charge.kind] ?? charge.label.trim();
      const key = charge.kind === "miscFee" ? `miscFee:${label.toLowerCase()}` : charge.kind;
      const group = groups.get(key) ?? { annual: 0, kind: charge.kind, label };
      group.annual = r2(group.annual + charge.annual);
      groups.set(key, group);
    }
  }
  return [...groups.values()]
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || collator.compare(a.label, b.label))
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
