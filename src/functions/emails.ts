// Emails — minimal intake for the Incoming page. Real email arrival will
// come from a Microsoft Graph webhook or Logic App; this endpoint lets any
// such upstream post the parsed email to us. `promoteEmailToQuote` matches
// an email to a job by id (from the subject, typically `Job #N`) and mints
// a Quote row with SourceEmailID set.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { createConnection, executeQuery, closeConnection } from "../db";
import { extractToken, unauthorizedResponse, errorResponse } from "../auth";
import { generateReadSasUrl } from "../blob-storage";
import { graphSendReply, graphFetchEmails, GraphEmail } from "../graph";
import { formatDocNumber, nameToAcronym } from "../doc-number";
import { runParseBatch } from "./parseEmails";

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
    .filter((n): n is string => typeof n === "string" && n.length > 0)
    .map((blobName) => ({
      blobName,
      fileName: blobName.split("/").pop() ?? blobName,
      url: generateReadSasUrl(blobName, hour),
    }));
}

const EMAIL_COLUMNS = `
  EmailID, MessageID, FromAddress, Subject, Body, ReceivedAt,
  AttachmentBlobs, MatchedJobID, Status, ProcessedAt, CreatedAt,
  AIParsedAt, AIClassification, AIConfidence, AIParsedData,
  AIFlaggedForReview
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
    connection = await createConnection(token);

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
    return { status: 200, jsonBody: { count: rows.length, emails: rows, page, pageSize, total } };
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

  const emailId = Number(request.query.get("emailId"));
  if (!emailId) {
    return { status: 400, jsonBody: { error: "emailId (number) is required" } };
  }

  let connection;
  try {
    connection = await createConnection(token);
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
// MessageID so replays are safe.

async function ingestEmail(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const { MessageID, FromAddress, Subject, Body, ReceivedAt, AttachmentBlobs } = body ?? {};
    if (!MessageID || typeof MessageID !== "string") {
      return { status: 400, jsonBody: { error: "MessageID (string) required" } };
    }

    connection = await createConnection(token);

    // Best-effort match by subject — subjects like "Re: Job #123 ..." link
    // the email to the target job so the UI can display it in context.
    const jobMatch = typeof Subject === "string"
      ? Subject.match(/job\s*#?\s*(\d+)/i)
      : null;
    const matchedJobId = jobMatch ? Number(jobMatch[1]) : null;

    await executeQuery(
      connection,
      `IF NOT EXISTS (SELECT 1 FROM Emails WHERE MessageID = @MessageID)
         INSERT INTO Emails
           (MessageID, FromAddress, Subject, Body, ReceivedAt, AttachmentBlobs,
            MatchedJobID, Status)
         VALUES
           (@MessageID, @FromAddress, @Subject, @Body, @ReceivedAt, @AttachmentBlobs,
            @MatchedJobID, @Status);`,
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

  let connection;
  try {
    const body = (await request.json()) as any;
    const { EmailID, JobID, Amount, ContractorID, ContractorName, Notes, CreatedBy } = body ?? {};
    if (typeof EmailID !== "number") {
      return { status: 400, jsonBody: { error: "EmailID (number) required" } };
    }

    connection = await createConnection(token);

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

  let connection;
  try {
    const body = (await request.json()) as any;
    const { EmailID } = body ?? {};
    if (typeof EmailID !== "number") {
      return { status: 400, jsonBody: { error: "EmailID (number) required" } };
    }

    connection = await createConnection(token);
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

  let connection;
  try {
    const body = (await request.json()) as any;
    const { EmailID } = body ?? {};
    if (typeof EmailID !== "number") {
      return { status: 400, jsonBody: { error: "EmailID (number) required" } };
    }

    connection = await createConnection(token);
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

  let connection;
  try {
    const body = (await request.json()) as any;
    const { EmailID, CreatedBy, ExistingJobID } = body ?? {};
    if (typeof EmailID !== "number") {
      return { status: 400, jsonBody: { error: "EmailID (number) required" } };
    }

    connection = await createConnection(token);

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

  let connection;
  try {
    const body = (await request.json()) as any;
    const { EmailID, JobID, Amount, ContractorName, Description, InvoiceNumber, CreatedBy } = body ?? {};
    if (typeof EmailID !== "number" || typeof JobID !== "number") {
      return {
        status: 400,
        jsonBody: { error: "EmailID and JobID (numbers) are required" },
      };
    }

    connection = await createConnection(token);

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

// ── GET /api/getEmailThread?emailId=N ───────────────────────────────────────
// Returns all outbound replies stored in EmailReplies for the given email.

async function getEmailThread(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const emailId = Number(request.query.get("emailId"));
  if (!emailId) {
    return { status: 400, jsonBody: { error: "emailId (number) is required" } };
  }

  let connection;
  try {
    connection = await createConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT ReplyID, EmailID, Body, ToAddress, SentBy, SentAt,
              GraphMessageID, GraphSent, GraphError, AttachmentNames
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
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const { EmailID, Body: replyBody, SentBy, ToAddress, Attachments } = body ?? {};
    if (typeof EmailID !== "number" || typeof replyBody !== "string" || !replyBody.trim()) {
      return { status: 400, jsonBody: { error: "EmailID (number) and Body (string) required" } };
    }
    const attachments: Array<{ fileName: string; contentType: string; contentBase64: string }> =
      Array.isArray(Attachments) ? Attachments : [];

    connection = await createConnection(token);

    // Fetch email metadata for Graph send (subject + messageId for threading)
    const emailRows = await executeQuery(
      connection,
      `SELECT Subject, MessageID, FromAddress FROM Emails WHERE EmailID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: EmailID }],
    );
    if (!emailRows[0]) {
      return { status: 404, jsonBody: { error: "Email not found" } };
    }
    const email = emailRows[0] as { Subject: string | null; MessageID: string | null; FromAddress: string | null };

    const toAddr = ToAddress ?? email.FromAddress ?? null;

    const attachmentNames = attachments.map((a) => a.fileName);
    const attachmentNamesJson = attachmentNames.length ? JSON.stringify(attachmentNames) : null;

    // Store reply first — Graph send is best-effort.
    const inserted = await executeQuery(
      connection,
      `INSERT INTO EmailReplies (EmailID, Body, ToAddress, SentBy, AttachmentNames)
       OUTPUT INSERTED.ReplyID
       VALUES (@EmailID, @Body, @ToAddress, @SentBy, @AttachmentNames)`,
      [
        { name: "EmailID", type: TYPES.Int, value: EmailID },
        { name: "Body", type: TYPES.NVarChar, value: replyBody },
        { name: "ToAddress", type: TYPES.NVarChar, value: toAddr },
        { name: "SentBy", type: TYPES.NVarChar, value: SentBy ?? null },
        { name: "AttachmentNames", type: TYPES.NVarChar, value: attachmentNamesJson },
      ],
    );
    const replyId = inserted[0].ReplyID as number;

    // Attempt Graph send — fail gracefully.
    let graphSent = false;
    let graphMessageId: string | null = null;
    let graphError: string | null = null;
    if (toAddr) {
      try {
        graphMessageId = await graphSendReply(
          toAddr,
          email.Subject ?? "(no subject)",
          replyBody,
          email.MessageID,
          attachments.length ? attachments : undefined,
          SentBy ? [SentBy] : undefined,
        );
        graphSent = true;
      } catch (err: any) {
        graphError = err?.message ?? "Unknown Graph error";
        context.warn("Graph sendMail failed (reply still stored):", graphError);
      }
    }

    // Update Graph outcome on the stored reply row.
    await executeQuery(
      connection,
      `UPDATE EmailReplies
       SET GraphSent = @GraphSent, GraphMessageID = @GraphMessageID, GraphError = @GraphError
       WHERE ReplyID = @ReplyID`,
      [
        { name: "GraphSent", type: TYPES.Bit, value: graphSent ? 1 : 0 },
        { name: "GraphMessageID", type: TYPES.NVarChar, value: graphMessageId },
        { name: "GraphError", type: TYPES.NVarChar, value: graphError },
        { name: "ReplyID", type: TYPES.Int, value: replyId },
      ],
    );

    return {
      status: 200,
      jsonBody: { replyId, graphSent, graphError: graphError ?? undefined },
    };
  } catch (error: any) {
    context.error("sendEmailReply failed:", error.message);
    return errorResponse("Failed to send email reply", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── Shared: upsert a batch of Graph emails into the DB ───────────────────────

export async function upsertGraphEmails(
  connection: import("tedious").Connection,
  emails: GraphEmail[],
): Promise<void> {
  for (const email of emails) {
    const jobMatch = email.subject?.match(/job\s*#?\s*(\d+)/i) ?? null;
    const matchedJobId = jobMatch ? Number(jobMatch[1]) : null;
    const attachmentBlobsJson =
      email.attachmentBlobNames.length > 0
        ? JSON.stringify(email.attachmentBlobNames)
        : null;

    await executeQuery(
      connection,
      `IF NOT EXISTS (SELECT 1 FROM Emails WHERE MessageID = @MessageID)
         INSERT INTO Emails (MessageID, FromAddress, Subject, Body, ReceivedAt, MatchedJobID, Status, AttachmentBlobs)
         VALUES (@MessageID, @FromAddress, @Subject, @Body, @ReceivedAt, @MatchedJobID, 'unread', @AttachmentBlobs)`,
      [
        { name: "MessageID", type: TYPES.NVarChar, value: email.internetMessageId },
        { name: "FromAddress", type: TYPES.NVarChar, value: email.fromAddress },
        { name: "Subject", type: TYPES.NVarChar, value: email.subject },
        { name: "Body", type: TYPES.NVarChar, value: email.bodyContent },
        { name: "ReceivedAt", type: TYPES.DateTime2, value: email.receivedAt ? new Date(email.receivedAt) : null },
        { name: "MatchedJobID", type: TYPES.Int, value: matchedJobId },
        { name: "AttachmentBlobs", type: TYPES.NVarChar, value: attachmentBlobsJson },
      ],
    );
  }
}

// ── POST /api/syncEmailsNow ─────────────────────────────────────────────────
// Manually pulls unread emails from the configured mailbox and upserts them.
// Superseded by the Graph webhook once deployed.

async function syncEmailsNow(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const mailbox = process.env.GRAPH_MAILBOX_DEV;
  if (!mailbox) {
    return { status: 500, jsonBody: { error: "GRAPH_MAILBOX_DEV not configured" } };
  }

  let connection;
  try {
    connection = await createConnection(token);
    const latestRows = await executeQuery(connection, "SELECT MAX(ReceivedAt) AS LatestReceivedAt FROM Emails");
    const rawDate = latestRows[0]?.LatestReceivedAt as Date | string | null;
    const sinceDateTime = rawDate ? new Date(rawDate).toISOString() : undefined;

    const emails = await graphFetchEmails(mailbox, sinceDateTime);
    await upsertGraphEmails(connection, emails);
    closeConnection(connection);
    connection = undefined;

    await runParseBatch(token, context);

    context.log(`syncEmailsNow: fetched ${emails.length} emails from ${mailbox}`);
    return { status: 200, jsonBody: { mailbox, fetched: emails.length } };
  } catch (error: any) {
    context.error("syncEmailsNow failed:", error.message);
    return errorResponse("Sync failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
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

app.http("syncEmailsNow", { methods: ["POST"], authLevel: "anonymous", handler: syncEmailsNow });
