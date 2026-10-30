// Certificate intake (TR8): the reads behind the "certificate" hint on an Incoming email, and the single
// place an email's attachments are listed from the stored AttachmentBlobs. Reads only.

import { TYPES, type Connection } from "tedious";
import { isBlobName, WR_ATTACHMENTS_SHAPES } from "../blob-names";
import { executeQuery } from "../db";
import { matchSender } from "../inboundTriage/load";
import { certificateFileType, certificateSignal, type CertificateSignal, type EmailAttachmentRef } from "./signal";

export interface EmailFacts {
  aiText: string | null;
  attachments: EmailAttachmentRef[];
  body: string | null;
  emailId: number;
  fromAddress: string | null;
  senderVerified: boolean;
  subject: string | null;
}

/** The files an email carries that the register could keep: server-minted names only, PDF and images only. */
export function attachmentsOf(raw: unknown): EmailAttachmentRef[] {
  if (typeof raw !== "string" || raw === "") return [];
  let names: unknown;
  try {
    names = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(names)) return [];
  const out: EmailAttachmentRef[] = [];
  for (const entry of names) {
    const blobName = typeof entry === "string" ? entry : (entry as { blobName?: unknown } | null)?.blobName;
    if (typeof blobName !== "string" || !isBlobName(blobName, WR_ATTACHMENTS_SHAPES)) continue;
    const named = typeof entry === "object" && entry !== null ? (entry as { fileName?: unknown }).fileName : undefined;
    const fileName = typeof named === "string" && named !== "" ? named : (blobName.split("/").pop() ?? blobName);
    const contentType = certificateFileType(fileName);
    if (contentType) out.push({ blobName, contentType, fileName });
  }
  return out;
}

const EMAIL_SQL = `SELECT EmailID, FromAddress, Subject, LEFT(Body, 4000) AS BodyStart, AttachmentBlobs, AIClassification,
    LEFT(AIParsedData, 2000) AS AiData, CASE WHEN SenderAuthenticated = 1 THEN 1 ELSE 0 END AS SenderVerified
  FROM dbo.Emails
  WHERE EmailID IN (SELECT CAST([value] AS INT) FROM OPENJSON(@Ids)) AND ArchivedAt IS NULL AND IsTest = 0`;

export async function loadEmailFacts(connection: Connection, emailIds: readonly number[]): Promise<EmailFacts[]> {
  if (emailIds.length === 0) return [];
  const rows = await executeQuery(connection, EMAIL_SQL, [{ name: "Ids", type: TYPES.NVarChar, value: JSON.stringify(emailIds) }]);
  return rows.map((row) => ({
    aiText: [row.AIClassification, row.AiData].filter((part): part is string => typeof part === "string" && part !== "").join("\n") || null,
    attachments: attachmentsOf(row.AttachmentBlobs),
    body: (row.BodyStart as string | null) ?? null,
    emailId: Number(row.EmailID),
    fromAddress: (row.FromAddress as string | null) ?? null,
    senderVerified: Number(row.SenderVerified) === 1,
    subject: (row.Subject as string | null) ?? null,
  }));
}

export interface FiledAttachment {
  blobName: string;
  documentId: number;
  filedAt: string;
  filedBy: string;
}

const FILINGS_SQL = `SELECT EmailId, AttachmentBlobName, DocumentId, FiledByName, FiledAt FROM dbo.EmailCertificateFilings
  WHERE EmailId IN (SELECT CAST([value] AS INT) FROM OPENJSON(@Ids))`;

export async function loadFilings(connection: Connection, emailIds: readonly number[]): Promise<Map<number, FiledAttachment[]>> {
  const out = new Map<number, FiledAttachment[]>();
  if (emailIds.length === 0) return out;
  const rows = await executeQuery(connection, FILINGS_SQL, [{ name: "Ids", type: TYPES.NVarChar, value: JSON.stringify(emailIds) }]);
  for (const row of rows) {
    const list = out.get(Number(row.EmailId)) ?? [];
    list.push({
      blobName: String(row.AttachmentBlobName),
      documentId: Number(row.DocumentId),
      filedAt: new Date(row.FiledAt as Date | string).toISOString(),
      filedBy: String(row.FiledByName),
    });
    out.set(Number(row.EmailId), list);
  }
  return out;
}

export interface EmailCertificateView {
  attachments: Array<{ blobName: string; contentType: string; fileName: string; filed: FiledAttachment | null }>;
  confidence: CertificateSignal["confidence"] | null;
  contractorId: number | null;
  contractorName: string | null;
  emailId: number;
  insuranceTypes: string[];
  reasons: string[];
  /** True when nothing has been filed from it yet and it still looks like a certificate. */
  suggested: boolean;
}

const CONTRACTOR_SQL = `SELECT ContractorID, ContractorName FROM dbo.Contractors WHERE ContractorID = @Id`;

/**
 * For each email that looks like a certificate (or already had one filed from it), the hint Incoming shows.
 * Emails that are neither are left out. `aiOn` is whether the AI gateway is on: only then is the AI reading used.
 */
export async function loadCertificateViews(connection: Connection, emailIds: readonly number[], aiOn: boolean): Promise<EmailCertificateView[]> {
  const facts = await loadEmailFacts(connection, emailIds);
  const filings = await loadFilings(connection, emailIds);
  const names = new Map<number, string | null>();
  const views: EmailCertificateView[] = [];
  for (const email of facts) {
    const filed = filings.get(email.emailId) ?? [];
    const sender = await matchSender(connection, email.fromAddress);
    const signal = certificateSignal({
      aiText: aiOn ? email.aiText : null,
      attachments: email.attachments,
      body: email.body,
      senderKind: sender.kind,
      senderVerified: email.senderVerified,
      subject: email.subject,
    });
    if (!signal && filed.length === 0) continue;
    if (sender.contractorId !== null && !names.has(sender.contractorId)) {
      const [row] = await executeQuery(connection, CONTRACTOR_SQL, [{ name: "Id", type: TYPES.Int, value: sender.contractorId }]);
      names.set(sender.contractorId, row?.ContractorName ? String(row.ContractorName) : null);
    }
    const attachments = email.attachments.map((file) => ({ ...file, filed: filed.find((entry) => entry.blobName === file.blobName) ?? null }));
    views.push({
      attachments,
      confidence: signal?.confidence ?? null,
      contractorId: sender.contractorId,
      contractorName: sender.contractorId === null ? null : (names.get(sender.contractorId) ?? null),
      emailId: email.emailId,
      insuranceTypes: signal?.insuranceTypes ?? [],
      reasons: signal?.reasons ?? [],
      suggested: signal !== null && attachments.some((file) => file.filed === null),
    });
  }
  return views;
}
