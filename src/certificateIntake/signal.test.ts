/// <reference types="jest" />
import { certificateFileType, certificateSignal, type CertificateSignalInput } from "./signal";

const pdf = { blobName: "email-attachments/abc/00000000-0000-4000-8000-000000000000.pdf", contentType: "application/pdf", fileName: "Certificate of Currency 2026.pdf" };
const base: CertificateSignalInput = { aiText: null, attachments: [pdf], body: "Hi, please find our insurance attached.", senderKind: "contractor", senderVerified: true, subject: "Updated certificate of currency" };

describe("certificateSignal", () => {
  it("suggests on a verified contractor with a PDF and certificate wording, by rules alone", () => {
    const signal = certificateSignal(base);
    expect(signal?.confidence).toBe("rules");
    expect(signal?.reasons[0]).toMatch(/certificate of currency/);
  });

  it("names the kinds of cover it finds", () => {
    const signal = certificateSignal({ ...base, subject: "Insurance", body: "Public liability and workers comp attached", attachments: [{ ...pdf, fileName: "pl.pdf" }] });
    expect(signal?.insuranceTypes).toEqual(["Public liability", "Workers compensation"]);
  });

  it("finds the wording in the file name", () => {
    expect(certificateSignal({ ...base, subject: "Hello", body: "see attached" })).not.toBeNull();
    expect(certificateSignal({ ...base, subject: "Hello", body: "see attached", attachments: [{ ...pdf, fileName: "scan.pdf" }] })).toBeNull();
  });

  it("adds confidence from the AI reading, but never creates a suggestion from it", () => {
    expect(certificateSignal({ ...base, aiText: "insurance certificate" })?.confidence).toBe("rules_ai");
    expect(certificateSignal({ ...base, aiText: "insurance certificate", subject: "Hi", body: "hello", attachments: [{ ...pdf, fileName: "scan.pdf" }] })).toBeNull();
  });

  it.each([
    ["an unknown sender", { senderKind: "unknown" as const }],
    ["a tenancy", { senderKind: "tenancy" as const }],
    ["an unverified sender", { senderVerified: false }],
    ["no attachment", { attachments: [] }],
    ["only a Word attachment", { attachments: [{ ...pdf, fileName: "coc.docx" }] }],
    ["a bare mention of insurance", { subject: "Insurance question", body: "Can you tell me about insurance?", attachments: [{ ...pdf, fileName: "scan.pdf" }] }],
  ])("is null for %s", (_, change) => {
    expect(certificateSignal({ ...base, ...change })).toBeNull();
  });
});

describe("certificateFileType", () => {
  it("accepts what the register keeps and nothing else", () => {
    expect(certificateFileType("a.PDF")).toBe("application/pdf");
    expect(certificateFileType("a.jpeg")).toBe("image/jpeg");
    expect(certificateFileType("a.docx")).toBeNull();
    expect(certificateFileType("noextension")).toBeNull();
  });
});
