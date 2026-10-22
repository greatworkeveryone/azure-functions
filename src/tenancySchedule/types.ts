// The Tenancy Schedule report's wire shape (command-centre .harness/TENANCY-SCHEDULE-REPORT-2026-10-22.md,
// "Contract (TS1-TS2)"). The frontend mirrors these types in src/types/; change both.

import type { PendingChangeItem, PendingChanges } from "../scheduleChange/pending";

export interface TenancyScheduleUnit {
  area: string;
  level: string;
  sizeSqm: number;
}

/** annual in dollars; monthly = annual / 12; perSqm = annual / NLA, null when NLA is 0. All to the cent. */
export interface TenancyScheduleMoney {
  annual: number;
  monthly: number;
  perSqm: number | null;
}

export type TenancyScheduleChargeKind = "ahac" | "carparkGroup" | "miscFee" | "relief" | "rent";

export interface TenancyScheduleCharge extends TenancyScheduleMoney {
  /** carparkGroup only: the group's bay count. */
  bays: number | null;
  effectiveFrom: string | null;
  kind: TenancyScheduleChargeKind;
  /** "Rent", "After-hours A/C", a fee's title, a group's label, "Rent relief". */
  label: string;
}

export type TenancyScheduleReviewMethod = "cpi" | "fixed" | "market" | "other";

export interface TenancyScheduleReview {
  /** "Rent", then the other charges that review on the date. */
  appliesTo: string[];
  date: string;
  /** "CPI Darwin", "Fixed 4%", "Market review", or the step's note. */
  description: string;
  method: TenancyScheduleReviewMethod;
  /** A review for this date is awaiting a director. */
  pending: boolean;
}

export interface TenancyScheduleNoteSection {
  rows: { body: string; subheader: string }[];
  title: string;
}

export interface TenancyScheduleLease {
  charges: TenancyScheduleCharge[];
  commencement: string | null;
  contact: { email: string | null; name: string | null; phone: string | null } | null;
  expiry: string | null;
  leaseCode: string | null;
  legalName: string;
  notes: TenancyScheduleNoteSection[];
  nlaSqm: number;
  optionPeriods: string | null;
  parkingBays: number;
  pendingChanges: PendingChangeItem[];
  reviews: TenancyScheduleReview[];
  scheduleSignedOff: boolean;
  status: "current" | "holdover" | "pending";
  tenantId: number;
  termMonths: number | null;
  total: TenancyScheduleMoney;
  tradingName: string | null;
  units: TenancyScheduleUnit[];
}

export interface TenancyScheduleVacancy {
  nlaSqm: number;
  tenantId: number;
  units: TenancyScheduleUnit[];
}

export type TenancyScheduleGapKind = "noContact" | "noExpiry" | "noOccupancy" | "scheduleNotSignedOff";

export interface TenancyScheduleGap {
  kinds: TenancyScheduleGapKind[];
  name: string;
  tenantId: number;
}

export interface TenancyScheduleSummaryLine extends TenancyScheduleMoney {
  kind: TenancyScheduleChargeKind;
  label: string;
}

export interface TenancyScheduleSummary {
  bays: { leased: number; other: number; total: number; vacant: number };
  byLabel: TenancyScheduleSummaryLine[];
  leaseCount: number;
  total: TenancyScheduleMoney;
  totalNlaSqm: number;
  vacantNlaSqm: number;
  vacantPercent: number;
}

export interface TenancyScheduleBuilding {
  address: string | null;
  buildingId: number;
  gaps: TenancyScheduleGap[];
  leases: TenancyScheduleLease[];
  name: string;
  pendingChangeCount: number;
  referenceCode: string | null;
  summary: TenancyScheduleSummary;
  vacancies: TenancyScheduleVacancy[];
}

export interface TenancyScheduleResponse {
  asOf: string;
  buildings: TenancyScheduleBuilding[];
  generatedAt: string;
  pendingChanges: PendingChanges;
  portfolio: TenancyScheduleSummary;
}
