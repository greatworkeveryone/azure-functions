// The Compliance report's first section: contractors on a building whose certificate of
// currency is missing, expired or expiring. Who is "on" a building is decided by the
// caller (build.ts): the contractors on its live service schedules, and those named in
// its coverage. Pure.

import { compareContractors } from "./contractors";
import { insuranceNotices, type InsuranceDocument } from "./insuranceEvidence";
import type { CertificateFinding, ComplianceContractor } from "./types";

interface CertificateInput {
  asOf: string;
  buildingId: number;
  /** The contractors assigned to the building. */
  contractors: readonly ComplianceContractor[];
  documents: readonly InsuranceDocument[];
}

/**
 * One finding per contractor and kind of insurance that doesn't read as recorded. A
 * contractor whose evidence is all in order has none; one with nothing on record has a
 * single "missing" finding.
 */
export function certificateFindings({ asOf, buildingId, contractors, documents }: CertificateInput): CertificateFinding[] {
  return [...contractors]
    .sort(compareContractors)
    .flatMap((contractor) =>
      insuranceNotices(documents, contractor.contractorId, asOf, buildingId).flatMap((notice): CertificateFinding[] =>
        notice.state === "recorded"
          ? []
          : [
              {
                ...contractor,
                expiresOn: notice.document?.expiresOn ?? null,
                insuranceType: notice.type,
                startsOn: notice.state === "missing" ? (notice.document?.issuedOn ?? null) : null,
                state: notice.state,
              },
            ],
      ),
    )
    .sort((a, b) => compareContractors(a, b) || a.insuranceType.localeCompare(b.insuranceType, "en-AU"));
}
