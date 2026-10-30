// Certificate intake (TR8): the body of POST /api/fileEmailCertificate, checked before the database is touched.
// The person filing is never taken from the body. The register's own rules (parseDocumentInput) then check the
// contractor, type, dates and responsible person; this file checks what is specific to filing from an email.

import { parseDocumentInput, type RegisteredDocumentInput } from "../documentRegister";

export interface FileCertificateBody {
  acknowledge: boolean;
  attachmentBlobName: string;
  document: RegisteredDocumentInput;
  emailId: number;
}

type Parsed = { error: string; ok: false } | { ok: true; value: FileCertificateBody };

const KEYS = ["emailId", "attachmentBlobName", "contractorId", "insuranceType", "insurer", "policyNumber", "coverAmount", "issuedOn", "expiresOn", "notes", "acknowledge"];
const fail = (error: string): Parsed => ({ error, ok: false });
const optionalText = (value: unknown, label: string, max: number): string | { error: string } => {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.trim().length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return { error: `${label} must be plain text of up to ${max} characters` };
  return value.trim();
};

/** `ownerName` is the signed-in person's name: the register's "responsible person". */
export function parseFileCertificateBody(body: Record<string, unknown>, ownerName: string): Parsed {
  const extra = Object.keys(body).find((key) => !KEYS.includes(key));
  if (extra) return fail(`Unexpected field: ${extra}`);
  if (typeof body.emailId !== "number" || !Number.isInteger(body.emailId) || body.emailId < 1 || body.emailId > 2_147_483_647) return fail("emailId must be a whole number above zero");
  if (typeof body.attachmentBlobName !== "string" || body.attachmentBlobName === "") return fail("Choose the attachment to file");
  if (body.contractorId === undefined || body.contractorId === null) return fail("Choose the contractor this certificate is for");
  if (body.acknowledge !== undefined && typeof body.acknowledge !== "boolean") return fail("acknowledge must be true or false");

  const insurer = optionalText(body.insurer, "Insurer", 160);
  const policy = optionalText(body.policyNumber, "Policy number", 60);
  const extraNotes = optionalText(body.notes, "Notes", 2000);
  for (const part of [insurer, policy, extraNotes]) if (typeof part !== "string") return fail(part.error);
  let cover = "";
  if (body.coverAmount !== undefined && body.coverAmount !== null && body.coverAmount !== "") {
    if (typeof body.coverAmount !== "number" || !Number.isFinite(body.coverAmount) || body.coverAmount < 0 || body.coverAmount > 10_000_000_000) return fail("Cover amount must be a number");
    cover = `$${body.coverAmount.toLocaleString("en-AU", { maximumFractionDigits: 2 })}`;
  }
  // The register has no columns for these; they live in its notes, beside the original file.
  const notes = [
    insurer && `Insurer: ${insurer}`,
    policy && `Policy number: ${policy}`,
    cover && `Cover: ${cover}`,
    extraNotes,
    "Filed from an emailed certificate.",
  ]
    .filter(Boolean)
    .join("\n");
  const type = typeof body.insuranceType === "string" ? body.insuranceType.trim() : "";
  try {
    const document = parseDocumentInput({
      buildingId: null,
      category: "Insurance",
      contractorId: body.contractorId,
      expiresOn: body.expiresOn,
      insuranceType: type,
      issuedOn: body.issuedOn,
      kind: "certificate",
      notes,
      ownerName,
      reviewDue: null,
      tenantId: null,
      title: `${type || "Insurance"} certificate of currency`,
    });
    return { ok: true, value: { acknowledge: body.acknowledge === true, attachmentBlobName: body.attachmentBlobName, document, emailId: body.emailId } };
  } catch (error) {
    return fail(error instanceof Error ? error.message : "The certificate details are not valid");
  }
}
