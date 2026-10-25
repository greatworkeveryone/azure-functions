// The Maintenance spend report, built from what load.ts read. Pure: the rules the
// screen explains are here, and nowhere else.
//
//  - Only the commercial buildings load.ts returned are reported (company reporting
//    covers commercial buildings only, tenancy schedule decision T10), so an invoice
//    on any other building is dropped here even if a read were ever loosened.
//  - An invoice counts in the year of its invoice date (JobInvoices.ReceivedAt, the
//    form's "Invoice date"), read in Darwin time. With no invoice date it counts in
//    the year of its approval, and is counted as having fallen back; with neither it
//    is in no year and is counted as undated.
//  - Contractor invoices (incoming) are spend; approved outgoing invoices on an
//    on-chargeable job are on-charges recovered. Amounts are ex GST (gst.ts).
//  - A job is counted once, in its building and trade, when it has a contractor
//    invoice dated in the year.

import { exGstCents, fromCents, toCents } from "./gst";
import { isInFinancialYear, type FinancialYear } from "./financialYear";
import { compareTrades, tradeKey, tradeLabel } from "./trades";
import type { SqlRow } from "../db";
import type { MaintenanceSpendBuilding, MaintenanceSpendResponse, MaintenanceSpendScope, MaintenanceSpendTotals, MaintenanceSpendTrade } from "./types";

export interface MaintenanceSpendData {
  /** The commercial buildings in scope, as read. */
  buildings: readonly SqlRow[];
  /** Approved invoices on live jobs, with the job's building, category and on-charge flag. */
  invoices: readonly SqlRow[];
}

interface Tally {
  jobs: Set<number>;
  label: string;
  onCharge: number;
  spend: number;
}

const TOP_TRADES = 5;

const instantOf = (value: unknown): Date | null => {
  const instant = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return instant && !Number.isNaN(instant.getTime()) ? instant : null;
};

const isTrue = (value: unknown): boolean => value === true || value === 1;

const newTally = (label: string): Tally => ({ jobs: new Set(), label, onCharge: 0, spend: 0 });

function totalsOf(tallies: Iterable<Tally>): MaintenanceSpendTotals {
  let [jobCount, onCharge, spend] = [0, 0, 0];
  for (const tally of tallies) {
    jobCount += tally.jobs.size;
    onCharge += tally.onCharge;
    spend += tally.spend;
  }
  return { jobCount, onChargesRecovered: fromCents(onCharge), spend: fromCents(spend) };
}

const toTrade = (tally: Tally): MaintenanceSpendTrade => ({ trade: tally.label, ...totalsOf([tally]) });

function tallyFor(map: Map<string, Tally>, label: string): Tally {
  const key = tradeKey(label);
  const found = map.get(key);
  if (found) return found;
  const created = newTally(label);
  map.set(key, created);
  return created;
}

export function buildMaintenanceSpend(input: {
  data: MaintenanceSpendData;
  financialYear: FinancialYear;
  generatedAt: string;
  scope: MaintenanceSpendScope;
}): MaintenanceSpendResponse {
  const { data, financialYear: year, scope } = input;
  const commercial = new Map(data.buildings.map((row) => [Number(row.BuildingID), row]));
  const byBuilding = new Map<number, Map<string, Tally>>();
  const portfolio = new Map<string, Tally>();
  let [approvalFallbacks, undated] = [0, 0];

  for (const row of data.invoices) {
    const buildingId = Number(row.BuildingID);
    if (!commercial.has(buildingId)) continue;
    const cents = toCents(row.Amount);
    const outgoing = row.Direction === "outgoing";
    const incoming = row.Direction === "incoming" || row.Direction == null;
    if (cents === null || !(incoming || (outgoing && isTrue(row.IsOnchargeable)))) continue;
    const invoiceDate = instantOf(row.ReceivedAt);
    const instant = invoiceDate ?? instantOf(row.ApprovedAt);
    if (!instant) {
      undated += 1;
      continue;
    }
    if (!isInFinancialYear(instant, year)) continue;
    if (!invoiceDate) approvalFallbacks += 1;

    const label = tradeLabel(row.Category);
    const buildingTallies = byBuilding.get(buildingId) ?? new Map<string, Tally>();
    byBuilding.set(buildingId, buildingTallies);
    for (const tally of [tallyFor(buildingTallies, label), tallyFor(portfolio, label)]) {
      if (outgoing) {
        tally.onCharge += exGstCents(cents);
      } else {
        tally.spend += exGstCents(cents);
        tally.jobs.add(Number(row.JobID));
      }
    }
  }

  const buildings: MaintenanceSpendBuilding[] = [...commercial]
    .map(([buildingId, row]) => ({ buildingId, row, tallies: byBuilding.get(buildingId) }))
    .filter(({ tallies }) => tallies !== undefined || "buildingId" in scope)
    .map(({ buildingId, row, tallies }) => ({
      buildingId,
      name: String(row.BuildingName ?? ""),
      referenceCode: row.ReferenceCode == null ? null : String(row.ReferenceCode),
      total: totalsOf(tallies?.values() ?? []),
      trades: [...(tallies?.values() ?? [])].sort((a, b) => compareTrades(a.label, b.label)).map(toTrade),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "en-AU") || a.buildingId - b.buildingId);

  const topTrades = [...portfolio.values()]
    .filter((tally) => tally.spend > 0)
    .sort((a, b) => b.spend - a.spend || compareTrades(a.label, b.label))
    .slice(0, TOP_TRADES)
    .map(toTrade);

  return {
    buildings,
    dating: { approvalFallbacks, undated },
    financialYear: { from: year.from, label: year.label, to: year.to },
    generatedAt: input.generatedAt,
    portfolio: { ...totalsOf(portfolio.values()), buildingCount: buildings.length },
    topTrades,
  };
}
