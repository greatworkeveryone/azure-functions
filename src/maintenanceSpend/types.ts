// The wire shape of GET /getMaintenanceSpendReport, mirrored by command-centre
// src/types/maintenanceSpend.ts. Amounts are dollars ex GST, to the cent.

export type MaintenanceSpendScope = { all: true } | { buildingId: number };

export interface MaintenanceSpendTotals {
  /** Jobs with at least one approved contractor invoice dated in the year. */
  jobCount: number;
  /** Approved outgoing invoices on on-chargeable jobs, ex GST. */
  onChargesRecovered: number;
  /** Approved contractor invoices, ex GST. */
  spend: number;
}

export interface MaintenanceSpendTrade extends MaintenanceSpendTotals {
  trade: string;
}

export interface MaintenanceSpendBuilding {
  buildingId: number;
  name: string;
  referenceCode: string | null;
  total: MaintenanceSpendTotals;
  trades: MaintenanceSpendTrade[];
}

export interface MaintenanceSpendResponse {
  buildings: MaintenanceSpendBuilding[];
  /** How the invoices were dated, so the page can say so. */
  dating: {
    /** Counted invoices with no invoice date, dated by their approval instead. */
    approvalFallbacks: number;
    /** Approved invoices with neither date: in no year, so not counted. */
    undated: number;
  };
  financialYear: { from: string; label: string; to: string };
  generatedAt: string;
  portfolio: MaintenanceSpendTotals & { buildingCount: number };
  /** Up to five, by spend across the buildings in scope. */
  topTrades: MaintenanceSpendTrade[];
}
