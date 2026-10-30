/// <reference types="jest" />
import { parseFileCertificateBody } from "./input";

const good = { attachmentBlobName: "email-attachments/x/y.pdf", contractorId: 4, emailId: 9, expiresOn: "2027-03-01", insuranceType: "Public liability" };

describe("parseFileCertificateBody", () => {
  it("builds a register certificate with the filer as the responsible person, and keeps insurer, policy and cover in the notes", () => {
    const parsed = parseFileCertificateBody({ ...good, insurer: "QBE", policyNumber: "PL-1", coverAmount: 20000000 }, "Sam Staff");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.document).toMatchObject({ category: "Insurance", contractorId: 4, expiresOn: "2027-03-01", kind: "certificate", ownerName: "Sam Staff", tenantId: null });
    expect(parsed.value.document.notes).toMatch(/Insurer: QBE\nPolicy number: PL-1\nCover: \$20,000,000/);
    expect(parsed.value.acknowledge).toBe(false);
  });

  it.each([
    ["an unknown field", { surprise: 1 }],
    ["no contractor", { contractorId: null }],
    ["no insurance type", { insuranceType: "" }],
    ["an impossible date", { expiresOn: "2027-02-30" }],
    ["a non-boolean acknowledge", { acknowledge: "yes" }],
    ["a negative cover", { coverAmount: -1 }],
    ["no attachment", { attachmentBlobName: "" }],
  ])("refuses %s", (_, change) => {
    expect(parseFileCertificateBody({ ...good, ...change }, "Sam").ok).toBe(false);
  });
});
