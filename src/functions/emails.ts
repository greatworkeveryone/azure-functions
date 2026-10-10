// Emails — intake + promote actions for the Incoming page. Rows arrive from
// the email-sync queue (processEmailSync → upsertGraphEmails) or ingestEmail;
// `jobIdFromText` sets MatchedJobID deterministically. Promote endpoints turn
// an email into a Job, Quote, Invoice, job-timeline update
// (promoteEmailToJobUpdate) or a recorded director decision
// (recordEmailQuoteDecision), then flip it to 'promoted'.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES, type Connection } from "tedious";
import {
  beginTransaction,
  closeConnection,
  commitTransaction,
  createRequestConnection,
  executeQuery,
  rollbackTransaction,
} from "../db";
import { AppRole, extractToken, requireRole, verifiedIdentityFromRequest, unauthorizedResponse, errorResponse } from "../auth";
import { generateReadSasUrl } from "../blob-storage";
import { GraphEmail } from "../graph";
import { formatDocNumber, nameToAcronym } from "../doc-number";
import { jobIdFromText } from "../email/job-ref";
import { emailSyncQueueOutput, enqueueEmailSync } from "../email/sync-queue";
import { advanceJobStatus } from "../jobStatusHelpers";
import { AwaitingRole, JobEvent, JobStatus, nextState, type JobState } from "../jobStatusMachine";
import { checkRateLimit } from "../rateLimit";
import { resolveActivePlannerTasks } from "../planner";
import { approveDirectorQuote, rejectQuote } from "../quote-decisions";

// Server-generated email-attachment blobs land under emails/{messageId}/...
// where {messageId} is a sanitised, URL-safe slug. Used to reject ingest /
// claim attempts that point Attachments rows at arbitrary blob paths.
const EMAIL_BLOB_PREFIX_RE = /^emails\/[A-Za-z0-9_-]+\//;

// Shape returned next to the raw AttachmentBlobs string so the frontend can
// render click-to-open chips without a second round-trip for each file.
export interface EmailAttachmentDescriptor {
  blobName: string;
  fileName: string;
  url: string;
}

function hydrateAttachments(
  raw: string | null | undefined,
): EmailAttachmentDescriptor[] {
  if (!raw) return [];
  let names: unknown;
  try {
    names = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(names)) return [];
  const hour = 60 * 60 * 1000;
  return names
    .filter((n) => (typeof n === "string" && n.length > 0) || (typeof n === "object" && n !== null && "blobName" in n))
    .map((n) => {
      const blobName = typeof n === "string" ? n : (n as { blobName: string }).blobName;
      const fileName = typeof n === "string"
        ? (blobName.split("/").pop() ?? blobName)
        : (n as { blobName: string; fileName: string }).fileName;
      return { blobName, fileName, url: generateReadSasUrl(blobName, hour) };
    });
}

const EMAIL_COLUMNS = `
  EmailID, FromAddress, FromName, Subject, Body, ReceivedAt,
  AttachmentBlobs, MatchedJobID, Status, ProcessedAt, CreatedAt,
  AIParsedAt, AIClassification, AIConfidence, AIParsedData,
  AIFlaggedForReview, Source, SenderAuthenticated, AuthenticationResults
`;

// ── GET /api/getEmails ───────────────────────────────────────────────────────
// Query params:
//   statuses  — comma-separated list, e.g. "unread,matched" (default: unread,matched)
//   page      — 1-based page number (default: 1)
//   pageSize  — rows per page (default: 50, max: 100)
//   search    — optional free-text; filters by FromAddress or Subject (LIKE)
// Flagged rows are always excluded — those live on the admin Flagged page.

async function getEmails(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.USER, AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL]);
  if (denied) return denied;

  const rawStatuses = request.query.get("statuses") ?? "unread,matched";
  const statusList = rawStatuses
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const page = Math.max(1, Number(request.query.get("page") ?? "1"));
  const pageSize = Math.min(100, Math.max(1, Number(request.query.get("pageSize") ?? "50")));
  const offset = (page - 1) * pageSize;
  const search = request.query.get("search")?.trim() || undefined;

  // Flagged rows live on the admin-only Flagged Incoming page.
  const whereParts: string[] = ["AIFlaggedForReview = 0"];
  const params: { name: string; type: any; value: any }[] = [];

  if (search) {
    whereParts.push("(FromAddress LIKE @Search OR Subject LIKE @Search)");
    params.push({ name: "Search", type: TYPES.NVarChar, value: `%${search}%` });
  }

  if (statusList.length === 1) {
    whereParts.push("Status = @Status");
    params.push({ name: "Status", type: TYPES.NVarChar, value: statusList[0] });
  } else if (statusList.length > 1) {
    // Build Status IN (@S0, @S1, ...) from the validated list
    const placeholders = statusList.map((_, i) => `@S${i}`).join(", ");
    whereParts.push(`Status IN (${placeholders})`);
    statusList.forEach((s, i) =>
      params.push({ name: `S${i}`, type: TYPES.NVarChar, value: s }),
    );
  }

  const where = `WHERE ${whereParts.join(" AND ")}`;

  let connection;
  try {
    connection = await createRequestConnection(token);

    const countRows = await executeQuery(
      connection,
      `SELECT COUNT(*) AS Total FROM Emails ${where}`,
      params,
    );
    const total = (countRows[0]?.Total as number) ?? 0;

    const rows = await executeQuery(
      connection,
      `SELECT ${EMAIL_COLUMNS} FROM Emails ${where}
       ORDER BY ReceivedAt DESC
       OFFSET @Offset ROWS FETCH NEXT @PageSize ROWS ONLY`,
      [...params,
        { name: "Offset",   type: TYPES.Int, value: offset },
        { name: "PageSize", type: TYPES.Int, value: pageSize },
      ],
    );
    const emails = rows.map((row) => ({
      ...row,
      attachments: hydrateAttachments(row.AttachmentBlobs as string | null),
    }));
    return { status: 200, jsonBody: { count: emails.length, emails, page, pageSize, total } };
  } catch (error: any) {
    context.error("getEmails failed:", error.message);
    return errorResponse("Failed to fetch emails", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── GET /api/getEmail?emailId=N ─────────────────────────────────────────────
// Single-email lookup used by the Quote step's "View email" affordance when a
// user is validating an AI-parsed quote. Returns 404 if the id doesn't exist.

async function getEmail(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.USER, AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL]);
  if (denied) return denied;

  const emailId = Number(request.query.get("emailId"));
  if (!emailId) {
    return { status: 400, jsonBody: { error: "emailId (number) is required" } };
  }

  let connection;
  try {
    connection = await createRequestConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT ${EMAIL_COLUMNS} FROM Emails WHERE EmailID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: emailId }],
    );
    if (rows.length === 0) {
      return { status: 404, jsonBody: { error: "Email not found" } };
    }
    const row = rows[0];
    return {
      status: 200,
      jsonBody: {
        email: {
          ...row,
          attachments: hydrateAttachments(row.AttachmentBlobs as string | null),
        },
      },
    };
  } catch (error: any) {
    context.error("getEmail failed:", error.message);
    return errorResponse("Failed to fetch email", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/ingestEmail ────────────────────────────────────────────────────
// Body: { MessageID, FromAddress, Subject, Body, ReceivedAt, AttachmentBlobs? }
// Called by whatever email pipeline lands messages in our inbox. Dedupes on
// MessageID so replays are safe. Stamped Source = 'ingest' (never from the
// body) — FromAddress is caller-supplied, so these rows can't record a
// director decision.

export async function ingestEmail(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.ACCOUNTS_APPROVAL, AppRole.FACILITIES_APPROVAL]);
  if (denied) return denied;

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const callerOid = identity.oid;

  const rl = checkRateLimit(`ingestEmail:${callerOid}`, { limit: 60, windowMs: 60_000 });
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  let connection;
  try {
    const body = (await request.json()) as any;
    const { MessageID, FromAddress, Subject, Body, ReceivedAt, AttachmentBlobs } = body ?? {};
    if (!MessageID || typeof MessageID !== "string") {
      return { status: 400, jsonBody: { error: "MessageID (string) required" } };
    }

    // AttachmentBlobs is either a JSON array of blob-name strings or a JSON
    // array of { blobName, fileName } objects. Reject anything outside the
    // email-sync prefix so a caller can't slip Attachments rows pointing at
    // arbitrary blob paths into the inbox.
    if (typeof AttachmentBlobs === "string" && AttachmentBlobs.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(AttachmentBlobs);
      } catch {
        return { status: 400, jsonBody: { error: "AttachmentBlobs must be valid JSON" } };
      }
      if (!Array.isArray(parsed)) {
        return { status: 400, jsonBody: { error: "AttachmentBlobs must be a JSON array" } };
      }
      for (const entry of parsed) {
        const blobName = typeof entry === "string"
          ? entry
          : (entry && typeof entry === "object" && "blobName" in entry && typeof (entry as { blobName: unknown }).blobName === "string"
            ? (entry as { blobName: string }).blobName
            : null);
        if (!blobName || !EMAIL_BLOB_PREFIX_RE.test(blobName)) {
          return { status: 400, jsonBody: { error: "AttachmentBlobs entries must reference emails/{messageId}/..." } };
        }
      }
    }

    connection = await createRequestConnection(token);

    // Deterministic job match — shared with the Graph sync and the parse
    // worker (src/email/job-ref.ts) so MatchedJobID means the same everywhere.
    const matchedJobId = jobIdFromText(
      typeof Subject === "string" ? Subject : null,
      typeof Body === "string" ? Body : null,
    );

    await executeQuery(
      connection,
      `IF NOT EXISTS (SELECT 1 FROM Emails WHERE MessageID = @MessageID)
         INSERT INTO Emails
           (MessageID, FromAddress, Subject, Body, ReceivedAt, AttachmentBlobs,
            MatchedJobID, Status, Source)
         VALUES
           (@MessageID, @FromAddress, @Subject, @Body, @ReceivedAt, @AttachmentBlobs,
            @MatchedJobID, @Status, 'ingest');`,
      [
        { name: "MessageID", type: TYPES.NVarChar, value: MessageID },
        { name: "FromAddress", type: TYPES.NVarChar, value: FromAddress ?? null },
        { name: "Subject", type: TYPES.NVarChar, value: Subject ?? null },
        { name: "Body", type: TYPES.NVarChar, value: Body ?? null },
        { name: "ReceivedAt", type: TYPES.DateTime2, value: ReceivedAt ?? null },
        { name: "AttachmentBlobs", type: TYPES.NVarChar, value: AttachmentBlobs ?? null },
        { name: "MatchedJobID", type: TYPES.Int, value: matchedJobId },
        { name: "Status", type: TYPES.NVarChar, value: matchedJobId ? "matched" : "unread" },
      ],
    );

    const stored = await executeQuery(
      connection,
      `SELECT ${EMAIL_COLUMNS} FROM Emails WHERE MessageID = @MessageID`,
      [{ name: "MessageID", type: TYPES.NVarChar, value: MessageID }],
    );
    return { status: 200, jsonBody: { email: stored[0] } };
  } catch (error: any) {
    context.error("ingestEmail failed:", error.message);
    return errorResponse("Ingest email failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/promoteEmailToQuote ───────────────────────────────────────────
// Body: { EmailID, Amount?, ContractorID?, ContractorName?, Notes?, CreatedBy? }
// Creates a Quote against the email's MatchedJobID and flips the email to
// "promoted". The amount is usually extracted from the email body by the
// upstream parser; fall back to a user-supplied figure if absent.

async function promoteEmailToQuote(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.ACCOUNTS_APPROVAL, AppRole.FACILITIES_APPROVAL]);
  if (denied) return denied;

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const callerOid = identity.oid;

  const rl = checkRateLimit(`promoteEmailToQuote:${callerOid}`, { limit: 60, windowMs: 60_000 });
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  let connection;
  try {
    const body = (await request.json()) as any;
    const { EmailID, JobID, Amount, ContractorID, ContractorName, Notes } = body ?? {};
    if (typeof EmailID !== "number") {
      return { status: 400, jsonBody: { error: "EmailID (number) required" } };
    }
    // CreatedBy is derived from the verified token; body field is ignored.
    const CreatedBy = callerOid;

    connection = await createRequestConnection(token);

    const emailRows = await executeQuery(
      connection,
      `SELECT EmailID, MatchedJobID, ReceivedAt, AIClassification FROM Emails WHERE EmailID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: EmailID }],
    );
    const email = emailRows[0];
    if (!email) {
      return { status: 404, jsonBody: { error: "Email not found" } };
    }
    // JobID from the request body takes precedence; fall back to MatchedJobID on the email row.
    const jobId = (typeof JobID === "number" ? JobID : null) ?? (email.MatchedJobID as number | null);
    if (!jobId) {
      return {
        status: 400,
        jsonBody: { error: "JobID required (or email must be matched to a job)." },
      };
    }

    const seqRows = await executeQuery(
      connection,
      "SELECT ISNULL(MAX(Seq), 0) + 1 AS NextSeq FROM Quotes WHERE JobID = @JobID",
      [{ name: "JobID", type: TYPES.Int, value: jobId }],
    );
    const nextSeq = (seqRows[0]?.NextSeq as number) ?? 1;
    const quoteNumber = formatDocNumber({
      prefix: "QT",
      jobId,
      acronym: nameToAcronym(ContractorName ?? ""),
      seq: nextSeq,
    });

    // Only mark as needing AI validation when the email was actually AI-classified as
    // a quote. If the user promoted it manually (email classified as something else),
    // stamp AIValidatedAt immediately so the banner never appears.
    const needsAIValidation = (email.AIClassification as string | null) === "quote";
    const inserted = await executeQuery(
      connection,
      needsAIValidation
        ? `INSERT INTO Quotes
             (JobID, QuoteNumber, Seq, ContractorID, ContractorName, Amount,
              Notes, SourceEmailID, ReceivedAt, CreatedBy)
           OUTPUT INSERTED.QuoteID
           VALUES
             (@JobID, @QuoteNumber, @Seq, @ContractorID, @ContractorName, @Amount,
              @Notes, @EmailID, @ReceivedAt, @CreatedBy);`
        : `INSERT INTO Quotes
             (JobID, QuoteNumber, Seq, ContractorID, ContractorName, Amount,
              Notes, SourceEmailID, ReceivedAt, CreatedBy, AIValidatedAt, AIValidatedBy)
           OUTPUT INSERTED.QuoteID
           VALUES
             (@JobID, @QuoteNumber, @Seq, @ContractorID, @ContractorName, @Amount,
              @Notes, @EmailID, @ReceivedAt, @CreatedBy, SYSUTCDATETIME(), @AIValidatedBy);`,
      [
        { name: "JobID", type: TYPES.Int, value: jobId },
        { name: "QuoteNumber", type: TYPES.NVarChar, value: quoteNumber },
        { name: "Seq", type: TYPES.Int, value: nextSeq },
        { name: "ContractorID", type: TYPES.Int, value: ContractorID ?? null },
        { name: "ContractorName", type: TYPES.NVarChar, value: ContractorName ?? null },
        { name: "Amount", type: TYPES.Decimal, value: Amount ?? null },
        { name: "Notes", type: TYPES.NVarChar, value: Notes ?? null },
        { name: "EmailID", type: TYPES.Int, value: EmailID },
        { name: "ReceivedAt", type: TYPES.DateTime2, value: email.ReceivedAt ?? null },
        { name: "CreatedBy", type: TYPES.NVarChar, value: CreatedBy ?? null },
        ...(needsAIValidation ? [] : [{ name: "AIValidatedBy", type: TYPES.NVarChar, value: CreatedBy ?? null }]),
      ],
    );
    const newQuoteId = inserted[0].QuoteID as number;

    await executeQuery(
      connection,
      `UPDATE Emails SET Status = 'promoted', ProcessedAt = SYSUTCDATETIME()
       WHERE EmailID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: EmailID }],
    );

    return { status: 200, jsonBody: { quoteId: newQuoteId, jobId } };
  } catch (error: any) {
    context.error("promoteEmailToQuote failed:", error.message);
    return errorResponse("Promote email failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/archiveEmail ──────────────────────────────────────────────────
// Body: { EmailID: number }
// Sets Status = 'archived' and stamps ProcessedAt so the email leaves the
// active inbox without being tied to a job/quote/invoice.

async function archiveEmail(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.USER, AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL]);
  if (denied) return denied;

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const callerOid = identity.oid;

  const rl = checkRateLimit(`archiveEmail:${callerOid}`, { limit: 60, windowMs: 60_000 });
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  let connection;
  try {
    const body = (await request.json()) as any;
    const { EmailID } = body ?? {};
    if (typeof EmailID !== "number") {
      return { status: 400, jsonBody: { error: "EmailID (number) required" } };
    }

    connection = await createRequestConnection(token);
    await executeQuery(
      connection,
      `UPDATE Emails SET Status = 'archived', ProcessedAt = SYSUTCDATETIME()
       WHERE EmailID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: EmailID }],
    );

    return { status: 200, jsonBody: { ok: true } };
  } catch (error: any) {
    context.error("archiveEmail failed:", error.message);
    return errorResponse("Archive email failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/flagEmailForReview ────────────────────────────────────────────
// Body: { EmailID: number }
// Sets AIFlaggedForReview = 1, removing the email from the active inbox and
// surfacing it on the admin Flagged Incoming page for model review.

async function flagEmailForReview(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.USER, AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL]);
  if (denied) return denied;

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const callerOid = identity.oid;

  const rl = checkRateLimit(`flagEmailForReview:${callerOid}`, { limit: 60, windowMs: 60_000 });
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  let connection;
  try {
    const body = (await request.json()) as any;
    const { EmailID } = body ?? {};
    if (typeof EmailID !== "number") {
      return { status: 400, jsonBody: { error: "EmailID (number) required" } };
    }

    connection = await createRequestConnection(token);
    await executeQuery(
      connection,
      `UPDATE Emails SET AIFlaggedForReview = 1 WHERE EmailID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: EmailID }],
    );

    return { status: 200, jsonBody: { ok: true } };
  } catch (error: any) {
    context.error("flagEmailForReview failed:", error.message);
    return errorResponse("Flag email for review failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/promoteEmailToJob ─────────────────────────────────────────────
// Body: { EmailID: number, CreatedBy?: string }
// Creates a Job row sourced from the email (title from subject), marks the
// email as 'promoted', and returns the new job id.

async function promoteEmailToJob(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.ACCOUNTS_APPROVAL, AppRole.FACILITIES_APPROVAL]);
  if (denied) return denied;

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const callerOid = identity.oid;

  const rl = checkRateLimit(`promoteEmailToJob:${callerOid}`, { limit: 60, windowMs: 60_000 });
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  let connection;
  try {
    const body = (await request.json()) as any;
    const { EmailID, ExistingJobID } = body ?? {};
    if (typeof EmailID !== "number") {
      return { status: 400, jsonBody: { error: "EmailID (number) required" } };
    }
    // CreatedBy is derived from the verified token; body field is ignored.
    const CreatedBy = callerOid;

    connection = await createRequestConnection(token);

    let jobId: number;

    if (typeof ExistingJobID === "number") {
      // Job was already created by the caller (e.g. EmailJobForm) — just mark the email.
      jobId = ExistingJobID;
    } else {
      const emailRows = await executeQuery(
        connection,
        `SELECT EmailID, Subject FROM Emails WHERE EmailID = @Id`,
        [{ name: "Id", type: TYPES.Int, value: EmailID }],
      );
      if (!emailRows[0]) {
        return { status: 404, jsonBody: { error: "Email not found" } };
      }

      const subject = (emailRows[0].Subject as string | null) ?? "Email job";
      const title = subject.length > 200 ? subject.slice(0, 200) : subject;

      const inserted = await executeQuery(
        connection,
        `INSERT INTO Jobs (Title, Status, CreatedBy, CreationMethod, SourceEmailID)
         OUTPUT INSERTED.JobID
         VALUES (@Title, 'New', @CreatedBy, 'email', @EmailID)`,
        [
          { name: "Title", type: TYPES.NVarChar, value: title },
          { name: "CreatedBy", type: TYPES.NVarChar, value: CreatedBy ?? null },
          { name: "EmailID", type: TYPES.Int, value: EmailID },
        ],
      );
      jobId = inserted[0].JobID as number;
    }

    await executeQuery(
      connection,
      `UPDATE Emails SET Status = 'promoted', ProcessedAt = SYSUTCDATETIME()
       WHERE EmailID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: EmailID }],
    );

    return { status: 200, jsonBody: { jobId } };
  } catch (error: any) {
    context.error("promoteEmailToJob failed:", error.message);
    return errorResponse("Promote email to job failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/promoteEmailToInvoice ─────────────────────────────────────────
// Body: { EmailID, JobID, Amount?, Description?, CreatedBy? }
// Creates an Invoice row linked to the job, marks the email as 'promoted'.

async function promoteEmailToInvoice(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.ACCOUNTS_APPROVAL, AppRole.FACILITIES_APPROVAL]);
  if (denied) return denied;

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const callerOid = identity.oid;

  const rl = checkRateLimit(`promoteEmailToInvoice:${callerOid}`, { limit: 60, windowMs: 60_000 });
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  let connection;
  try {
    const body = (await request.json()) as any;
    const { EmailID, JobID, Amount, ContractorName, Description, InvoiceNumber } = body ?? {};
    if (typeof EmailID !== "number" || typeof JobID !== "number") {
      return {
        status: 400,
        jsonBody: { error: "EmailID and JobID (numbers) are required" },
      };
    }
    // CreatedBy is derived from the verified token; body field is ignored.
    const CreatedBy = callerOid;

    connection = await createRequestConnection(token);

    const inserted = await executeQuery(
      connection,
      `INSERT INTO JobInvoices
         (JobID, Amount, ContractorName, InvoiceNumber, Notes, SourceEmailID, CreatedBy, Status)
       OUTPUT INSERTED.JobInvoiceID
       VALUES (@JobID, @Amount, @ContractorName, @InvoiceNumber, @Description, @EmailID, @CreatedBy, 'pending')`,
      [
        { name: "JobID", type: TYPES.Int, value: JobID },
        { name: "Amount", type: TYPES.Decimal, value: Amount ?? null },
        { name: "ContractorName", type: TYPES.NVarChar, value: ContractorName ?? null },
        { name: "InvoiceNumber", type: TYPES.NVarChar, value: InvoiceNumber ?? null },
        { name: "Description", type: TYPES.NVarChar, value: Description ?? null },
        { name: "EmailID", type: TYPES.Int, value: EmailID },
        { name: "CreatedBy", type: TYPES.NVarChar, value: CreatedBy ?? null },
      ],
    );
    const invoiceId = inserted[0].JobInvoiceID as number;

    await executeQuery(
      connection,
      `UPDATE Emails SET Status = 'promoted', ProcessedAt = SYSUTCDATETIME()
       WHERE EmailID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: EmailID }],
    );

    return { status: 200, jsonBody: { invoiceId } };
  } catch (error: any) {
    context.error("promoteEmailToInvoice failed:", error.message);
    return errorResponse("Promote email to invoice failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── Promote-roles ───────────────────────────────────────────────────────────
// Mirrors promoteEmailToJob / promoteEmailToQuote / promoteEmailToInvoice
// above and the matching capability in command-centre src/constants/roles.ts.
// Keep all of them in step — the frontend gate is UX, this list is the control.
const PROMOTE_EMAIL_ROLES = [AppRole.ACCOUNTS_APPROVAL, AppRole.FACILITIES_APPROVAL] as const;

const MAX_SQL_INT = 2147483647;
const MAX_NOTE_LENGTH = 4000;

function isValidId(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x > 0 && x <= MAX_SQL_INT;
}

// Email already consumed by a promote / decision — can't be acted on again.
function alreadyHandledResponse(status: string | null): HttpResponseInit | null {
  return status === "promoted" || status === "archived"
    ? { status: 422, jsonBody: { error: `Email is already ${status}` } }
    : null;
}

// ── POST /api/promoteEmailToJobUpdate ───────────────────────────────────────
// Body: { EmailID: number, JobID: number, Text: string, MarkWorkCompleted?: boolean }
// Records a reply on an existing job as a timeline note (EventType
// 'email_update', SourceEmailID set) and optionally fires WORK_COMPLETED:
// pre-check nextState(current, WORK_COMPLETED) — null → 422, nothing
// written — then advanceJobStatus; !advanced (the job moved underneath us)
// → 409 and rollback. Note + status change + email flip are one transaction.

interface PromoteEmailToJobUpdateBody {
  EmailID?: unknown;
  JobID?: unknown;
  MarkWorkCompleted?: unknown;
  Text?: unknown;
}

export async function promoteEmailToJobUpdate(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, PROMOTE_EMAIL_ROLES);
  if (denied) return denied;

  // CreatedBy comes from the verified token — never from the body.
  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  const rl = checkRateLimit(`promoteEmailToJobUpdate:${identity.oid}`, { limit: 60, windowMs: 60_000 });
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  const body = ((await request.json().catch(() => null)) ?? {}) as PromoteEmailToJobUpdateBody;
  const { EmailID, JobID, Text, MarkWorkCompleted } = body;
  if (!isValidId(EmailID) || !isValidId(JobID)) {
    return { status: 400, jsonBody: { error: "EmailID and JobID (positive integers) are required" } };
  }
  if (typeof Text !== "string" || Text.trim().length === 0) {
    return { status: 400, jsonBody: { error: "Text (non-empty string) is required" } };
  }
  if (Text.length > MAX_NOTE_LENGTH) {
    return { status: 400, jsonBody: { error: `Text must be at most ${MAX_NOTE_LENGTH} characters` } };
  }
  if (MarkWorkCompleted !== undefined && typeof MarkWorkCompleted !== "boolean") {
    return { status: 400, jsonBody: { error: "MarkWorkCompleted must be a boolean when provided" } };
  }
  const markCompleted = MarkWorkCompleted === true;

  let connection: Connection | undefined;
  let inTransaction = false;
  try {
    connection = await createRequestConnection(token);

    const emailRows = await executeQuery(
      connection,
      "SELECT Status, MatchedJobID FROM Emails WHERE EmailID = @Id",
      [{ name: "Id", type: TYPES.Int, value: EmailID }],
    );
    if (emailRows.length === 0) return { status: 404, jsonBody: { error: "Email not found" } };
    const handled = alreadyHandledResponse(emailRows[0].Status as string | null);
    if (handled) return handled;
    const priorJobId = emailRows[0].MatchedJobID as number | null;

    const jobRows = await executeQuery(
      connection,
      "SELECT Status, AwaitingRole FROM Jobs WHERE JobID = @JobID",
      [{ name: "JobID", type: TYPES.Int, value: JobID }],
    );
    if (jobRows.length === 0) return { status: 404, jsonBody: { error: "Job not found" } };

    if (markCompleted) {
      const current: JobState = {
        status: jobRows[0].Status as JobStatus,
        awaitingRole: (jobRows[0].AwaitingRole as AwaitingRole) ?? AwaitingRole.FACILITIES,
      };
      // Same machine advanceJobStatus consults — checked up front so an
      // illegal transition writes nothing, not even the note.
      if (nextState(current, JobEvent.WORK_COMPLETED) == null) {
        return {
          status: 422,
          jsonBody: { error: `Cannot mark work completed from status "${current.status}"`, from: current.status },
        };
      }
    }

    await beginTransaction(connection);
    inTransaction = true;

    const inserted = await executeQuery(
      connection,
      `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, SourceEmailID)
       OUTPUT INSERTED.JobEventID
       VALUES (@JobID, @CreatedBy, @Text, 'email_update', @EmailID);`,
      [
        { name: "JobID", type: TYPES.Int, value: JobID },
        { name: "CreatedBy", type: TYPES.NVarChar, value: identity.name },
        { name: "Text", type: TYPES.NVarChar, value: Text.trim() },
        { name: "EmailID", type: TYPES.Int, value: EmailID },
      ],
    );
    const eventId = inserted[0].JobEventID as number;

    let newStatus: string | null = null;
    if (markCompleted) {
      const advanced = await advanceJobStatus(connection, JobID, JobEvent.WORK_COMPLETED, { actor: identity.name });
      if (!advanced.advanced || !advanced.to) {
        // The job moved between our check and the write — refuse rather than
        // leave a note that claims completion.
        await rollbackTransaction(connection);
        inTransaction = false;
        return { status: 409, jsonBody: { error: "Job status changed concurrently — reload and try again" } };
      }
      newStatus = advanced.to.status;
    } else {
      await executeQuery(
        connection,
        "UPDATE Jobs SET LastModifiedDate = SYSUTCDATETIME() WHERE JobID = @JobID",
        [{ name: "JobID", type: TYPES.Int, value: JobID }],
      );
    }

    // Conditional flip: a concurrent promote leaves 0 rows → rollback + 409.
    const flipped = await executeQuery(
      connection,
      `UPDATE Emails
         SET Status = 'promoted',
             ProcessedAt = SYSUTCDATETIME(),
             MatchedJobID = @JobID
       OUTPUT inserted.EmailID
       WHERE EmailID = @Id AND Status NOT IN ('promoted', 'archived')`,
      [
        { name: "Id", type: TYPES.Int, value: EmailID },
        { name: "JobID", type: TYPES.Int, value: JobID },
      ],
    );
    if (flipped.length === 0) {
      await rollbackTransaction(connection);
      inTransaction = false;
      return { status: 409, jsonBody: { error: "Email was handled concurrently — reload and try again" } };
    }
    if (priorJobId != null && priorJobId !== JobID) {
      context.log(`promoteEmailToJobUpdate: email ${EmailID} MatchedJobID overridden ${priorJobId} -> ${JobID} by operator`);
    }

    await commitTransaction(connection);
    inTransaction = false;

    return { status: 200, jsonBody: { eventId, jobId: JobID, newStatus } };
  } catch (error: unknown) {
    if (connection && inTransaction) await rollbackTransaction(connection).catch(() => undefined);
    context.error("promoteEmailToJobUpdate failed:", error instanceof Error ? error.message : String(error));
    return errorResponse("Promote email to job update failed", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/recordEmailQuoteDecision ──────────────────────────────────────
// Body: { EmailID: number, QuoteID: number, Decision: "approved" | "rejected", Note?: string }
// Records a director's emailed approve / reject on a quote awaiting director
// sign-off. The caller is the operator (roles mirror promoteEmailToQuote);
// the director's authority comes from the SENDER checks: FromAddress must be a
// recipient of that quote's director packet AND an active AppUsers row with
// the literal Role = 'director' (admins excluded, as in directorApproveQuote).
// Before any of that the row must be mailbox-synced (Source = 'graph' —
// ingestEmail takes FromAddress from the caller) with an authenticated sender
// (SenderAuthenticated = 1, see src/email/sender-auth.ts) — From is spoofable.
// The actor stamped on the quote is that director's DisplayName, never the
// body. Helpers + email flip are one transaction.

interface RecordEmailQuoteDecisionBody {
  Decision?: unknown;
  EmailID?: unknown;
  Note?: unknown;
  QuoteID?: unknown;
}

// DirectorEmailSentTo is a JSON array (quotes.ts); tolerate a comma list.
function parseRecipientList(raw: string | null): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw.split(",");
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((r): r is string => typeof r === "string")
    .map((r) => r.trim().toLowerCase())
    .filter((r) => r.length > 0);
}

export async function recordEmailQuoteDecision(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, PROMOTE_EMAIL_ROLES);
  if (denied) return denied;

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  const rl = checkRateLimit(`recordEmailQuoteDecision:${identity.oid}`, { limit: 60, windowMs: 60_000 });
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  const body = ((await request.json().catch(() => null)) ?? {}) as RecordEmailQuoteDecisionBody;
  const { EmailID, QuoteID, Decision, Note } = body;
  if (!isValidId(EmailID) || !isValidId(QuoteID)) {
    return { status: 400, jsonBody: { error: "EmailID and QuoteID (positive integers) are required" } };
  }
  if (Decision !== "approved" && Decision !== "rejected") {
    return { status: 400, jsonBody: { error: 'Decision must be "approved" or "rejected"' } };
  }
  if (Note !== undefined && typeof Note !== "string") {
    return { status: 400, jsonBody: { error: "Note must be a string when provided" } };
  }
  if (Note !== undefined && Note.length > MAX_NOTE_LENGTH) {
    return { status: 400, jsonBody: { error: `Note must be at most ${MAX_NOTE_LENGTH} characters` } };
  }

  let connection: Connection | undefined;
  let inTransaction = false;
  try {
    connection = await createRequestConnection(token);

    const emailRows = await executeQuery(
      connection,
      "SELECT EmailID, FromAddress, Status, MatchedJobID, ReceivedAt, Source, SenderAuthenticated FROM Emails WHERE EmailID = @Id",
      [{ name: "Id", type: TYPES.Int, value: EmailID }],
    );
    if (emailRows.length === 0) return { status: 404, jsonBody: { error: "Email not found" } };
    const sender = ((emailRows[0].FromAddress as string | null) ?? "").trim().toLowerCase();
    const handled = alreadyHandledResponse(emailRows[0].Status as string | null);
    if (handled) return handled;
    if (emailRows[0].Source !== "graph") {
      return { status: 422, jsonBody: { error: "Only emails received through the mailbox can record a director decision" } };
    }
    const senderAuthenticated = emailRows[0].SenderAuthenticated;
    if (senderAuthenticated !== true && senderAuthenticated !== 1) {
      return {
        status: 422,
        jsonBody: {
          error:
            "The sender of this email couldn't be authenticated (DMARC/internal check failed) — ask the director to approve in-app",
        },
      };
    }
    if (!sender) return { status: 422, jsonBody: { error: "Email has no sender address" } };

    const quoteRows = await executeQuery(
      connection,
      "SELECT Status, JobID, DirectorEmailSentTo, DirectorEmailSentAt FROM Quotes WHERE QuoteID = @Id",
      [{ name: "Id", type: TYPES.Int, value: QuoteID }],
    );
    if (quoteRows.length === 0) return { status: 404, jsonBody: { error: "Quote not found" } };
    if ((quoteRows[0].Status as string | null) !== "awaiting_director") {
      return { status: 409, jsonBody: { error: "Quote must be in awaiting_director state" } };
    }

    // Bind the email to this quote: same job, and received after the packet went out.
    if (emailRows[0].MatchedJobID == null || emailRows[0].MatchedJobID !== quoteRows[0].JobID) {
      return { status: 422, jsonBody: { error: "Email is not matched to this quote's job" } };
    }
    const sentAt = quoteRows[0].DirectorEmailSentAt as Date | null;
    const receivedAt = emailRows[0].ReceivedAt as Date | null;
    if (!sentAt) {
      return { status: 422, jsonBody: { error: "No director approval email has been sent for this quote" } };
    }
    if (!receivedAt || new Date(receivedAt).getTime() < new Date(sentAt).getTime()) {
      return { status: 422, jsonBody: { error: "Email was received before the director approval email was sent" } };
    }

    // Check 1: the reply came from someone the packet was sent to.
    const recipients = parseRecipientList(quoteRows[0].DirectorEmailSentTo as string | null);
    if (!recipients.includes(sender)) {
      return { status: 422, jsonBody: { error: "Sender was not a recipient of the director approval email" } };
    }

    // Check 2: that address is a registered, active director (AppUsers.Email is stored lowercased).
    const directorRows = await executeQuery(
      connection,
      `SELECT DisplayName FROM AppUsers
        WHERE Email = @Email AND Role = 'director' AND IsActive = 1`,
      [{ name: "Email", type: TYPES.NVarChar, value: sender }],
    );
    if (directorRows.length === 0) {
      return { status: 422, jsonBody: { error: "Sender is not an active director" } };
    }
    const directorName = ((directorRows[0].DisplayName as string | null) ?? "").trim() || sender;

    await beginTransaction(connection);
    inTransaction = true;

    const outcome =
      Decision === "approved"
        ? await approveDirectorQuote(connection, {
            approvedBy: directorName,
            note: Note ?? null,
            quoteId: QuoteID,
            sourceEmailId: EmailID,
          })
        : await rejectQuote(connection, {
            expectedStatuses: ["awaiting_director"],
            note: Note ?? null,
            quoteId: QuoteID,
            rejectedBy: directorName,
            sourceEmailId: EmailID,
          });
    if (!outcome.ok) {
      await rollbackTransaction(connection);
      inTransaction = false;
      return { status: outcome.status, jsonBody: { error: outcome.error } };
    }

    // Conditional flip: a concurrent decision leaves 0 rows → rollback + 409.
    const flipped = await executeQuery(
      connection,
      `UPDATE Emails SET Status = 'promoted', ProcessedAt = SYSUTCDATETIME()
       OUTPUT inserted.EmailID
       WHERE EmailID = @Id AND Status NOT IN ('promoted', 'archived')`,
      [{ name: "Id", type: TYPES.Int, value: EmailID }],
    );
    if (flipped.length === 0) {
      await rollbackTransaction(connection);
      inTransaction = false;
      return { status: 409, jsonBody: { error: "Email was handled concurrently — reload and try again" } };
    }

    await commitTransaction(connection);
    inTransaction = false;

    // Approve, or reject out of awaiting_director, closes the director's Planner task. Best-effort.
    if (Decision === "approved" || outcome.previousStatus === "awaiting_director") {
      try {
        await resolveActivePlannerTasks("job", outcome.jobId, ["director_approval"]);
      } catch (err: unknown) {
        context.warn("plannerResolve (recordEmailQuoteDecision):", err instanceof Error ? err.message : String(err));
      }
    }

    return { status: 200, jsonBody: { quote: outcome.quote } };
  } catch (error: unknown) {
    if (connection && inTransaction) await rollbackTransaction(connection).catch(() => undefined);
    context.error("recordEmailQuoteDecision failed:", error instanceof Error ? error.message : String(error));
    return errorResponse("Record email quote decision failed", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── GET /api/getEmailThread?emailId=N ───────────────────────────────────────
// Returns all outbound replies stored in EmailReplies for the given email.

async function getEmailThread(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.USER, AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL]);
  if (denied) return denied;

  const emailId = Number(request.query.get("emailId"));
  if (!emailId) {
    return { status: 400, jsonBody: { error: "emailId (number) is required" } };
  }

  let connection;
  try {
    connection = await createRequestConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT ReplyID, EmailID, Body, ToAddress, SentBy, SentAt,
              GraphSent, GraphError, AttachmentNames
       FROM EmailReplies WHERE EmailID = @Id ORDER BY SentAt ASC`,
      [{ name: "Id", type: TYPES.Int, value: emailId }],
    );
    return { status: 200, jsonBody: { replies: rows } };
  } catch (error: any) {
    context.error("getEmailThread failed:", error.message);
    return errorResponse("Failed to fetch email thread", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/sendEmailReply ─────────────────────────────────────────────────
// Body: { EmailID, Body, SentBy?, ToAddress? }
// Stores the reply in EmailReplies, then attempts a Graph API send. Graph
// failure is recorded in GraphError but does not cause a non-200 response —
// the reply is always persisted so users can see what was recorded.

async function sendEmailReply(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.ACCOUNTS_APPROVAL, AppRole.FACILITIES_APPROVAL]);
  if (denied) return denied;

  // disabled 2026-05-30 — see plan
  return { status: 503, jsonBody: { error: "Outbound mail is temporarily disabled" } };
}

// ── Shared: upsert a batch of Graph emails into the DB ───────────────────────

// SQL unique-index / unique-constraint violations (migration 091).
const SQL_UNIQUE_VIOLATIONS: readonly number[] = [2601, 2627];

function isUniqueViolation(err: unknown): boolean {
  const number = (err as { number?: unknown } | null)?.number;
  return typeof number === "number" && SQL_UNIQUE_VIOLATIONS.includes(number);
}

export async function upsertGraphEmails(
  connection: import("tedious").Connection,
  emails: GraphEmail[],
): Promise<void> {
  for (const email of emails) {
    const matchedJobId = jobIdFromText(email.subject, email.bodyContent);
    const attachmentBlobsJson =
      email.attachmentBlobNames.length > 0
        ? JSON.stringify(email.attachmentBlobNames)
        : null;

    // UPDLOCK + HOLDLOCK: the range lock spans check and insert, so two
    // concurrent syncs can't both pass the check. A unique violation (091)
    // means another sync won the race — the row is stored, so skip it.
    try {
      await executeQuery(
        connection,
      `IF NOT EXISTS (SELECT 1 FROM Emails WITH (UPDLOCK, HOLDLOCK) WHERE MessageID = @MessageID)
         INSERT INTO Emails (MessageID, FromAddress, FromName, Subject, Body, ReceivedAt, MatchedJobID, Status, AttachmentBlobs,
                             Source, SenderAuthenticated, AuthenticationResults)
         VALUES (@MessageID, @FromAddress, @FromName, @Subject, @Body, @ReceivedAt, @MatchedJobID, 'unread', @AttachmentBlobs,
                 'graph', @SenderAuthenticated, @AuthenticationResults)
       ELSE IF @AttachmentBlobs IS NOT NULL
         UPDATE Emails SET AttachmentBlobs = @AttachmentBlobs
         WHERE MessageID = @MessageID AND AttachmentBlobs IS NULL`,
        [
          { name: "MessageID", type: TYPES.NVarChar, value: email.internetMessageId },
          { name: "FromAddress", type: TYPES.NVarChar, value: email.fromAddress },
          { name: "FromName", type: TYPES.NVarChar, value: email.fromName },
          { name: "Subject", type: TYPES.NVarChar, value: email.subject },
          { name: "Body", type: TYPES.NVarChar, value: email.bodyContent },
          { name: "ReceivedAt", type: TYPES.DateTime2, value: email.receivedAt ? new Date(email.receivedAt) : null },
          { name: "MatchedJobID", type: TYPES.Int, value: matchedJobId },
          { name: "AttachmentBlobs", type: TYPES.NVarChar, value: attachmentBlobsJson },
          { name: "SenderAuthenticated", type: TYPES.Bit, value: email.senderAuthenticated },
          { name: "AuthenticationResults", type: TYPES.NVarChar, value: email.authenticationResults },
        ],
      );
    } catch (err: unknown) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
}

// ── POST /api/syncEmailsNow ─────────────────────────────────────────────────
// Manual "check mail now". Enqueues an email-sync message and returns 202;
// processEmailSync (parseEmails.ts) does the Graph sync and the parse, so
// the request never waits on Graph or a cold model.

export async function syncEmailsNow(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.ACCOUNTS_APPROVAL, AppRole.FACILITIES_APPROVAL]);
  if (denied) return denied;

  if (!process.env.GRAPH_MAILBOX_DEV) {
    return { status: 500, jsonBody: { error: "GRAPH_MAILBOX_DEV not configured" } };
  }

  enqueueEmailSync(context, "manual");
  return { status: 202, jsonBody: { queued: true } };
}

app.http("getEmails", { methods: ["GET"], authLevel: "anonymous", handler: getEmails });
app.http("getEmail", { methods: ["GET"], authLevel: "anonymous", handler: getEmail });
app.http("ingestEmail", { methods: ["POST"], authLevel: "anonymous", handler: ingestEmail });
app.http("promoteEmailToQuote", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: promoteEmailToQuote,
});
app.http("flagEmailForReview", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: flagEmailForReview,
});
app.http("archiveEmail", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: archiveEmail,
});
app.http("promoteEmailToJob", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: promoteEmailToJob,
});
app.http("promoteEmailToInvoice", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: promoteEmailToInvoice,
});
app.http("promoteEmailToJobUpdate", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: promoteEmailToJobUpdate,
});
app.http("recordEmailQuoteDecision", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: recordEmailQuoteDecision,
});
app.http("getEmailThread", {
  methods: ["GET"],
  authLevel: "anonymous",
  handler: getEmailThread,
});
app.http("sendEmailReply", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: sendEmailReply,
});

app.http("syncEmailsNow", {
  methods: ["POST"],
  authLevel: "anonymous",
  extraOutputs: [emailSyncQueueOutput],
  handler: syncEmailsNow,
});
