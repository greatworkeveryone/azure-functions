// POST /api/fileEmailCertificate
//   { emailId, attachmentBlobName, contractorId, insuranceType, expiresOn, issuedOn?, insurer?, policyNumber?,
//     coverAmount?, notes?, acknowledge? }
//
// Certificate intake (TR8, PLAN §15): files a contractor's emailed certificate of currency in one click. The
// attachment of the Incoming email is read from storage and kept as the ORIGINAL evidence of a register document
// through the same path the register's own upload uses (storeRegisterDocument: one file in `documentation/`, its
// "created" audit row), then the email is linked to the document, who filed it is recorded and an `email.file_certificate`
// ledger row is written, all in one transaction. Nothing here is automatic: a person chose every field (AI only
// prefilled the form), and one attachment of one email can be filed once (409 afterwards).
//
// `acknowledge: true` then queues the optional "received, thanks" email (template certificate_received, a draft until
// Facilities approves it) through the send core (EB1), so COMMS_SEND_ENABLED, COMMS_SEND_DRY_RUN, DEV_EMAIL_OVERRIDE
// and the test-record egress guard all apply. It is off unless CERTIFICATE_ACK_ENABLED is "true", is refused for admin
// (who sends nothing real), and a failure to queue it never undoes the filing: the answer says what happened.
//
// Who may: ACTION_ROLES.fileEmailCertificate. Behind the certificateIntake flag: 404 while it is not enabled for the caller.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES, type Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { badRequest as badRequestResponse, readJsonBody } from "../assetRegisterSupport";
import { AppRole, errorResponse } from "../auth";
import { downloadBlob } from "../blob-storage";
import { CERT_ACK_TEMPLATE_ID, CERT_ACK_TEMPLATE_SLUG, acknowledgementEnabled } from "../certificateIntake/config";
import { parseFileCertificateBody } from "../certificateIntake/input";
import { attachmentsOf } from "../certificateIntake/load";
import { authorizeActor, badRequest, conflict, noStore, notFound, type CommsActor } from "../comms/actor";
import { approvalThreshold, commsMode, fromAddress, fromName } from "../comms/config";
import { applyResolutions, checkRecipients, isBlocked, writeJob } from "../comms/queueJob";
import { prepareSender } from "../comms/senderSetup";
import type { NewJob } from "../comms/types";
import { findUserByOid } from "../comms/userSignatureStore";
import { closeConnection, createRequestConnection, executeQuery } from "../db";
import { isFeatureEnabledForRoles } from "../features/flags";
import { loadTemplateBySlug } from "../intake/template";
import { record } from "../ledger";
import { ledgerUserActor } from "../ledger/actor";
import { checkRateLimit } from "../rateLimit";
import { showTestData } from "../test-data";
import { storeRegisterDocument } from "./document-register";

const EMAIL_SQL = `SELECT EmailID, FromAddress, AttachmentBlobs, CASE WHEN SenderAuthenticated = 1 THEN 1 ELSE 0 END AS SenderVerified
  FROM dbo.Emails WHERE EmailID = @Id AND ArchivedAt IS NULL AND IsTest = 0`;
const CONTRACTOR_SQL = `SELECT ContractorName FROM dbo.Contractors WHERE ContractorID = @Id`;
const FILED_SQL = `SELECT FiledByName FROM dbo.EmailCertificateFilings WITH (UPDLOCK, HOLDLOCK) WHERE EmailId = @Email AND AttachmentBlobName = @Blob`;

type Ack = { status: "failed" | "not_sent"; detail: string } | { status: "queued"; correspondenceId: number | null; jobStatus: string | null };

/** Queues the thank-you email. Returns what happened; never throws past the filing. */
async function sendAcknowledgement(connection: Connection, actor: CommsActor, to: { address: string; name: string }, filingKey: string): Promise<Ack> {
  if (!acknowledgementEnabled()) return { detail: "The thank-you email is switched off.", status: "not_sent" };
  if (actor.roles.every((role) => role === AppRole.ADMIN)) return { detail: "Admin accounts don't send real email; use a staff account.", status: "not_sent" };
  const template = await loadTemplateBySlug(connection, CERT_ACK_TEMPLATE_SLUG);
  if (!template) return { detail: "The certificate_received email template isn't in the library yet.", status: "not_sent" };
  if (!template.approved && commsMode() === "live") return { detail: "The certificate_received email template hasn't been approved yet, so it can't be sent.", status: "not_sent" };
  const setup = await prepareSender(connection, actor, { replyTo: { kind: "own" }, signatureMode: "personal" });
  if (!setup.ok) return { detail: "Your sending identity isn't set up, so the thank-you email wasn't queued.", status: "not_sent" };
  const job: NewJob = {
    bodyMarkdown: template.bodyMarkdown,
    createdBy: { email: actor.email, name: actor.name, oid: actor.oid, role: actor.role },
    fromAddress: fromAddress(),
    fromName: fromName(),
    kind: "letter",
    recipients: [{ address: to.address, mergeValues: {}, name: to.name, recipientRefId: null, recipientType: "manual" }],
    replyTo: { address: setup.replyTo.address, identityId: setup.replyTo.identity?.identityId ?? null, name: setup.replyTo.name },
    signature: setup.signature,
    signatureMode: "personal",
    subject: template.subject,
    templateId: CERT_ACK_TEMPLATE_ID,
    templateVersion: template.version,
  };
  const checked = await applyResolutions(connection, checkRecipients(job));
  if (checked.every(isBlocked)) {
    const first = checked[0];
    return { detail: `The thank-you email can't be sent. ${first.refusal?.detail ?? (first.composed.ok ? "" : first.composed.detail)}`.trim(), status: "not_sent" };
  }
  const user = await findUserByOid(connection, actor.oid);
  const queued = await writeJob(connection, job, checked, actor, user?.userId ?? null, approvalThreshold(), filingKey);
  return { correspondenceId: queued.correspondenceId, jobStatus: queued.status, status: "queued" };
}

export async function fileEmailCertificate(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeActor(request, ACTION_ROLES.fileEmailCertificate.gate);
  if (!auth.ok) return auth.response;
  const { actor } = auth;
  const limited = checkRateLimit(`fileEmailCertificate:${actor.oid}`, { limit: 30 });
  if (!limited.allowed) return { headers: { "Retry-After": String(Math.ceil(limited.retryAfterMs / 1000)) }, jsonBody: { error: "Too many filings, try again shortly" }, status: 429 };
  const raw = await readJsonBody(request);
  if (!raw) return badRequestResponse("JSON object required");
  const parsed = parseFileCertificateBody(raw, actor.name.slice(0, 160));
  if (!parsed.ok) return badRequest(parsed.error);
  const { acknowledge, attachmentBlobName, document, emailId } = parsed.value;
  if (acknowledge && actor.roles.every((role) => role === AppRole.ADMIN)) return badRequest("Admin accounts don't send real email; file without the thank-you email or use a staff account.");

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    if (!(await isFeatureEnabledForRoles("certificateIntake", actor.roles, { connection }))) return notFound("Not available");
    const email = (await executeQuery(connection, EMAIL_SQL, [{ name: "Id", type: TYPES.Int, value: emailId }]))[0];
    if (!email) return notFound("No such email");
    const file = attachmentsOf(email.AttachmentBlobs).find((entry) => entry.blobName === attachmentBlobName);
    if (!file) return badRequest("That file isn't an attachment of this email, or isn't a PDF or image the register can keep");

    const bytes = await downloadBlob(file.blobName);
    const user = await findUserByOid(connection, actor.oid);
    const showTest = await showTestData(request);
    let filingId = 0;
    const stored = await storeRegisterDocument(
      { caller: { name: actor.name, oid: actor.oid }, connection, roles: actor.roles, showTest },
      context,
      document,
      { bytes, contentType: file.contentType, fileName: file.fileName },
      async (documentId) => {
        const already = await executeQuery(connection as Connection, FILED_SQL, [
          { name: "Email", type: TYPES.Int, value: emailId },
          { name: "Blob", type: TYPES.NVarChar, value: file.blobName },
        ]);
        if (already.length > 0) return conflict(`This file was already filed by ${String(already[0].FiledByName)}`);
        const rows = await executeQuery(
          connection as Connection,
          `INSERT dbo.EmailCertificateFilings (EmailId, AttachmentBlobName, DocumentId, ContractorId, FiledByUserId, FiledByName)
           OUTPUT INSERTED.FilingId VALUES (@Email, @Blob, @Doc, @Contractor, @User, @Name)`,
          [
            { name: "Email", type: TYPES.Int, value: emailId },
            { name: "Blob", type: TYPES.NVarChar, value: file.blobName },
            { name: "Doc", type: TYPES.Int, value: documentId },
            { name: "Contractor", type: TYPES.Int, value: document.contractorId },
            { name: "User", type: TYPES.Int, value: user?.userId ?? null },
            { name: "Name", type: TYPES.NVarChar, value: actor.name.slice(0, 160) },
          ],
        );
        filingId = Number(rows[0].FilingId);
        await record(connection as Connection, {
          action: "email.file_certificate",
          actor: ledgerUserActor({ name: actor.name, roles: actor.roles, userId: user?.userId ?? null }),
          after: { contractorId: document.contractorId, documentId, expiresOn: document.expiresOn, fileName: file.fileName, insuranceType: document.insuranceType },
          subject: { id: emailId, type: "email" },
        });
        return null;
      },
    );
    if (stored.status !== 201) return stored;
    const documentId = Number((stored.jsonBody as { documentId: number }).documentId);

    let acknowledgement: Ack | null = null;
    if (acknowledge) {
      try {
        const contractor = (await executeQuery(connection, CONTRACTOR_SQL, [{ name: "Id", type: TYPES.Int, value: document.contractorId }]))[0];
        const address = typeof email.FromAddress === "string" ? email.FromAddress.trim().toLowerCase() : "";
        if (Number(email.SenderVerified) !== 1 || address === "") {
          acknowledgement = { detail: "The sender of the email couldn't be verified, so no thank-you was sent.", status: "not_sent" };
        } else {
          // One key per filing: a retry finds the email already queued and doesn't queue a second.
          acknowledgement = await sendAcknowledgement(connection, actor, { address, name: String(contractor?.ContractorName ?? "") }, `certificate-ack-${filingId}`);
          if (acknowledgement.status === "queued" && acknowledgement.correspondenceId !== null) {
            await executeQuery(connection, `UPDATE dbo.EmailCertificateFilings SET AcknowledgementJobId = @Job WHERE FilingId = @Id AND AcknowledgementJobId IS NULL`, [
              { name: "Job", type: TYPES.Int, value: acknowledgement.correspondenceId },
              { name: "Id", type: TYPES.Int, value: filingId },
            ]);
          }
        }
      } catch (error) {
        context.error("fileEmailCertificate acknowledgement failed:", error instanceof Error ? error.message : error);
        acknowledgement = { detail: "The certificate was filed, but the thank-you email couldn't be queued.", status: "failed" };
      }
    }
    return { headers: noStore, jsonBody: { acknowledgement, attachmentBlobName: file.blobName, documentId, emailId, filingId }, status: 201 };
  } catch (error) {
    context.error("fileEmailCertificate failed:", error instanceof Error ? error.message : error);
    return errorResponse("Could not file the certificate", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("fileEmailCertificate", { authLevel: "anonymous", handler: fileEmailCertificate, methods: ["POST"] });
