// The wire shape of GET /getComplianceReport, mirrored by command-centre
// src/types/compliance.ts. Dates are Darwin calendar dates, "YYYY-MM-DD".
//
// Every finding is one line a person can act on, and carries the ids the screen
// needs to link to the record that fixes it (the contractor, the building's
// coverage, the schedule, the defects period). Words are the screen's to choose.

import type { DefectsEnforcement, DefectsScope, DefectsServices } from "../facilitiesRules";

export type ComplianceScope = { all: true } | { buildingId: number };

/** "suspended" wins over "inactive": a suspended contractor is never one to use. */
export type ContractorStanding = "active" | "inactive" | "suspended";

/**
 * expired: ended before the date. expiring: ends on the date or within 30 days after it.
 * undated: a certificate is on record with no expiry. missing: none on record that covers
 * the date, either none at all or only ones that start after it.
 */
export type CertificateState = "expired" | "expiring" | "missing" | "undated";

export interface ComplianceContractor {
  contractorId: number;
  name: string;
  standing: ContractorStanding;
}

export interface CertificateFinding extends ComplianceContractor {
  /** The expiry of the certificate that was checked; null when there is none, or none recorded. */
  expiresOn: string | null;
  /** "Certificate of currency" when the contractor has none recorded at all. */
  insuranceType: string;
  /** state "missing" with a certificate on record: the day it starts, after the report date. */
  startsOn: string | null;
  state: CertificateState;
}

export interface TradeGapFinding {
  /** Everyone named for the trade when it has anyone: all inactive or suspended. Empty when nobody is named. */
  named: ComplianceContractor[];
  /** none_named: nobody is named for the trade. none_active: everyone named is inactive or suspended. */
  reason: "none_active" | "none_named";
  trade: string;
}

export interface OverdueScheduleFinding {
  contractorName: string | null;
  daysOverdue: number;
  /** The next due date, which is before the report date. */
  dueDate: string;
  name: string;
  serviceScheduleId: number;
  /** The asset ("Chiller 1 (CH-01)") or the described scope; null when neither is recorded. */
  target: string | null;
  trade: string;
}

export interface DefectsPeriodFinding {
  contractorName: string | null;
  defectsPeriodId: number;
  endsOn: string;
  enforcement: DefectsEnforcement;
  levelName: string | null;
  scope: DefectsScope;
  services: DefectsServices;
  /** Practical completion: the first day of the period. */
  startsOn: string;
  tenantName: string | null;
  works: string;
}

export interface ComplianceBuilding {
  buildingId: number;
  certificates: CertificateFinding[];
  defectsPeriods: DefectsPeriodFinding[];
  name: string;
  overdueSchedules: OverdueScheduleFinding[];
  referenceCode: string | null;
  tradeGaps: TradeGapFinding[];
}

export interface ComplianceCounts {
  certificates: number;
  defectsPeriods: number;
  overdueSchedules: number;
  tradeGaps: number;
}

export interface ComplianceReportResponse {
  asOf: string;
  /** All commercial buildings: only those with something to show. One building: that building, even with nothing. */
  buildings: ComplianceBuilding[];
  /** What was looked at, so a screen can tell "nothing is wrong" from "nothing was set up to check". */
  checked: {
    buildings: number;
    /** Contractor and building pairs: each contractor on a live schedule or named in coverage, per building. */
    contractors: number;
    /** Trades that buildings in scope have been set to require. */
    requiredTrades: number;
    /** Live (active, not archived) service schedules in scope. */
    schedules: number;
  };
  generatedAt: string;
  totals: ComplianceCounts & { buildingsWithFindings: number };
}
