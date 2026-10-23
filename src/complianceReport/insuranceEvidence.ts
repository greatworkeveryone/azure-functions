// Contractor insurance evidence: what the certificates of currency on a contractor's
// record say on a date. Pure.
//
// This is the rule the Maintenance warnings already apply (command-centre
// src/helpers/contractorInsurance.ts: the schedule editor's notice, the Maintenance
// round-up and the contractor evidence summary), kept here so the Compliance report
// reads it the same way on the server. The two are pinned together by one vector file
// (insurance-evidence.vectors.json, the same file in both repos): change both copies and
// the vectors together. It checks dates on retained evidence; it is not an insurer's
// verification, and it never says a contractor may not be used.
//
//  - Only insurance certificates for the contractor count. One kept for a single building
//    counts for that building only; one with no building is portfolio-wide and counts
//    for every building.
//  - Each kind of insurance is judged on its own (case and spacing ignored). A renewal
//    replaces an older certificate of the same kind: the one that runs longest wins.
//  - A certificate that starts after the date doesn't cover it.
//  - Expiring is the date itself and the 30 days after it. No expiry recorded is never
//    read as indefinite cover.

import { addDays } from "../facilitiesRules";

export const CERTIFICATE_WARNING_DAYS = 30;

/** Named when a contractor has no insurance certificate recorded at all. */
export const NO_CERTIFICATE_TYPE = "Certificate of currency";
const UNSPECIFIED_TYPE = "Unspecified insurance";

export interface InsuranceDocument {
  /** Where the document is kept: the register's service category. Only "Insurance" counts. */
  category: string;
  /** null: portfolio-wide. */
  buildingId: number | null;
  contractorId: number | null;
  expiresOn: string | null;
  insuranceType: string | null;
  issuedOn: string | null;
  /** The register's document type. Only "certificate" counts. */
  kind: string;
}

export type InsuranceState = "expired" | "expiring" | "missing" | "recorded" | "undated";

export interface InsuranceNotice {
  /** The certificate the state was read from; null when none is on record. */
  document: InsuranceDocument | null;
  state: InsuranceState;
  type: string;
}

const compareText = (left: string, right: string): number => left.localeCompare(right);

/**
 * One notice per kind of insurance the contractor holds for the building, or a single
 * "missing" notice when they hold none. `buildingId` null asks about no building in
 * particular: building-specific certificates then don't count.
 */
export function insuranceNotices(documents: readonly InsuranceDocument[], contractorId: number, onDate: string, buildingId: number | null): InsuranceNotice[] {
  const byType = new Map<string, InsuranceDocument[]>();
  for (const doc of documents) {
    if (doc.contractorId !== contractorId || doc.kind !== "certificate" || doc.category !== "Insurance") continue;
    if (doc.buildingId !== null && (buildingId === null || doc.buildingId !== buildingId)) continue;
    const key = (doc.insuranceType ?? UNSPECIFIED_TYPE).trim().toLocaleLowerCase("en-AU");
    byType.set(key, [...(byType.get(key) ?? []), doc]);
  }
  if (byType.size === 0) return [{ document: null, state: "missing", type: NO_CERTIFICATE_TYPE }];

  const soon = addDays(onDate, CERTIFICATE_WARNING_DAYS);
  return [...byType.values()].map((items): InsuranceNotice => {
    const inEffect = items.filter((doc) => !doc.issuedOn || doc.issuedOn <= onDate);
    const candidates = inEffect.length > 0 ? inEffect : items;
    const [document] = [...candidates].sort((a, b) => compareText(b.expiresOn ?? "", a.expiresOn ?? "") || compareText(b.issuedOn ?? "", a.issuedOn ?? ""));
    const type = document.insuranceType ?? UNSPECIFIED_TYPE;
    if (document.issuedOn && document.issuedOn > onDate) return { document, state: "missing", type };
    if (!document.expiresOn) return { document, state: "undated", type };
    if (document.expiresOn < onDate) return { document, state: "expired", type };
    if (document.expiresOn <= soon) return { document, state: "expiring", type };
    return { document, state: "recorded", type };
  });
}
