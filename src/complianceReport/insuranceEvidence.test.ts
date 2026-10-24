/// <reference types="jest" />
import vectors from "../__tests__/insurance-evidence.vectors.json";
import { CERTIFICATE_WARNING_DAYS, insuranceNotices, type InsuranceDocument } from "./insuranceEvidence";

// The same vector file sits in command-centre (src/__tests__/helpers/) and is asserted there
// against src/helpers/contractorInsurance.ts, the rule the Maintenance warnings apply. This
// is the backend copy the Compliance report reads: change both or neither.

const certificate = vectors.certificate as InsuranceDocument;

describe("insuranceNotices (shared vectors)", () => {
  it.each(vectors.cases)("$name", ({ buildingId, contractorId, documents, expected, onDate }) => {
    const docs = documents.map(({ patch }) => ({ ...certificate, ...patch }) as InsuranceDocument);
    const notices = insuranceNotices(docs, contractorId, onDate, buildingId);
    expect(notices.map((notice) => ({ expiresOn: notice.document?.expiresOn ?? null, state: notice.state, type: notice.type }))).toEqual(expected);
  });

  it("warns for 30 days, as the Maintenance round-up says", () => {
    expect(CERTIFICATE_WARNING_DAYS).toBe(30);
  });
});

describe("what the vectors do not say", () => {
  it("leaves the documents it is given alone", () => {
    const docs: InsuranceDocument[] = [{ ...certificate, expiresOn: "2026-09-01" }, { ...certificate, expiresOn: "2027-01-01" }];
    const before = JSON.stringify(docs);
    insuranceNotices(docs, 7, "2026-10-21", null);
    expect(JSON.stringify(docs)).toBe(before);
  });

  it("gives the certificate a state was read from, so a screen can show which one", () => {
    const docs: InsuranceDocument[] = [{ ...certificate, expiresOn: "2026-09-01" }];
    expect(insuranceNotices(docs, 7, "2026-10-21", null)[0].document).toBe(docs[0]);
  });
});
