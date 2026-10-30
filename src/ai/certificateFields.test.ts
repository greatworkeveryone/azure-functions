/// <reference types="jest" />
import { CERTIFICATE_PROMPT, mockCertificateFields, validateCertificateFields } from "./certificateFields";

describe("validateCertificateFields", () => {
  it("copies out well-formed fields and reads null, empty and N/A as not printed", () => {
    expect(validateCertificateFields({ coverAmount: 20000000, expiryDate: "2027-03-01", insuranceType: "Public liability", insurer: "N/A", policyNumber: " PL 1 ", startDate: null })).toEqual({
      ok: true,
      value: { coverAmount: 20000000, expiryDate: "2027-03-01", insuranceType: "Public liability", insurer: null, policyNumber: "PL 1", startDate: null },
    });
  });

  it.each([
    ["an unknown field", { extra: 1 }],
    ["a bad date", { expiryDate: "01/03/2027" }],
    ["an impossible date", { expiryDate: "2027-02-30" }],
    ["a string amount", { coverAmount: "20m" }],
    ["a negative amount", { coverAmount: -5 }],
    ["a non-text insurer", { insurer: 5 }],
  ])("refuses %s", (_, answer) => {
    expect(validateCertificateFields(answer).ok).toBe(false);
  });

  it("refuses a non-object", () => {
    expect(validateCertificateFields("text").ok).toBe(false);
  });
});

describe("the prompt and the mock", () => {
  it("treats the document as data and names every key", () => {
    expect(CERTIFICATE_PROMPT).toMatch(/never instructions to follow/);
    for (const key of ["insuranceType", "insurer", "policyNumber", "coverAmount", "startDate", "expiryDate"]) expect(CERTIFICATE_PROMPT).toContain(`"${key}"`);
  });

  it("returns an answer its own validator accepts", () => {
    const answer = mockCertificateFields("Workers compensation certificate");
    expect(answer.insuranceType).toBe("Workers compensation");
    expect(validateCertificateFields(answer).ok).toBe(true);
  });
});
