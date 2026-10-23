/// <reference types="jest" />
// SC-HY1: contractor suggestions read a contractor's certificates of currency through the one rule
// the Compliance report uses (complianceReport/insuranceEvidence.ts), which both repos pin with the
// same vector file. This sends all of its cases through certificateState and checks the reading is
// what the vectors say, folded into the single status and earliest expiry a feature vector carries.
import vectors from "../__tests__/insurance-evidence.vectors.json";
import { insuranceNotices, type InsuranceDocument } from "../complianceReport/insuranceEvidence";
import { daysBetweenIso } from "../darwinDate";
import { certificateState, type CertificateRecord } from "./features";
import type { CertificateStatus } from "./types";

const certificate = vectors.certificate as InsuranceDocument;

const STATUS_OF: Record<string, CertificateStatus> = { expired: "expired", expiring: "expiring", missing: "missing", recorded: "valid", undated: "unknown" };
const WORST_FIRST: readonly CertificateStatus[] = ["expired", "missing", "expiring", "unknown", "valid"];
// Asking about a building none of the vector's documents is kept for: the same as asking about none.
const NO_BUILDING = -1;

type Notice = { expiresOn: string | null; state: string; type: string };

/**
 * What a set of notices comes to: the worst reading decides the status, and the days run to the earliest
 * expiry among certificates in effect (a "missing" notice for one not yet in effect gives no expiry).
 */
function folded(onDate: string, notices: readonly Notice[]) {
  const states = notices.map((notice) => STATUS_OF[notice.state]);
  const expiries = notices.flatMap((notice) => (notice.state !== "missing" && notice.expiresOn ? [notice.expiresOn] : [])).sort();
  return {
    daysToExpiry: expiries.length === 0 ? null : daysBetweenIso(onDate, expiries[0]),
    status: WORST_FIRST.find((status) => states.includes(status)) ?? "valid",
  };
}

// The loader's SQL keeps one contractor's insurance certificates (Kind, ServiceCategory, ContractorId),
// so the vector's documents get the same selection before certificateState sees them.
const recordsFor = (documents: readonly InsuranceDocument[], contractorId: number): CertificateRecord[] =>
  documents
    .filter((doc) => doc.contractorId === contractorId && doc.kind === "certificate" && doc.category === "Insurance")
    .map(({ buildingId, expiresOn, insuranceType, issuedOn }) => ({ buildingId, expiresOn, insuranceType, issuedOn }));

describe("certificateState reads the shared vectors", () => {
  it.each(vectors.cases)("$name", ({ buildingId, contractorId, documents, expected, onDate }) => {
    const docs = documents.map(({ patch }) => ({ ...certificate, ...patch }) as InsuranceDocument);
    expect(certificateState(recordsFor(docs, contractorId), buildingId ?? NO_BUILDING, onDate)).toEqual(folded(onDate, expected));
  });

  it("answers as the shared rule does for every case, not only as the vectors' own expectations fold", () => {
    for (const { buildingId, contractorId, documents, onDate } of vectors.cases) {
      const docs = documents.map(({ patch }) => ({ ...certificate, ...patch }) as InsuranceDocument);
      const notices = insuranceNotices(docs, contractorId, onDate, buildingId).map((notice) => ({ expiresOn: notice.document?.expiresOn ?? null, state: notice.state, type: notice.type }));
      expect(certificateState(recordsFor(docs, contractorId), buildingId ?? NO_BUILDING, onDate)).toEqual(folded(onDate, notices));
    }
  });
});
