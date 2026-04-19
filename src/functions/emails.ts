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
  AttachmentBlobs, MatchedJobID, Status, ProcessedAt, CreatedAt
`;

// ── GET /api/getEmails[?status=unread|matched|promoted|ignored] ─────────────

async function getEmails(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const status = request.query.get("status");
  const where = status ? "WHERE Status = @Status" : "";
  const params = status
    ? [{ name: "Status", type: TYPES.NVarChar, value: status }]
    : [];

  let connection;
  try {
    connection = await createConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT ${EMAIL_COLUMNS} FROM Emails ${where} ORDER BY ReceivedAt DESC`,
      params,
    );
    return { status: 200, jsonBody: { count: rows.length, emails: rows } };
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
    const { EmailID, Amount, ContractorID, ContractorName, Notes, CreatedBy } = body ?? {};
    if (typeof EmailID !== "number") {
      return { status: 400, jsonBody: { error: "EmailID (number) required" } };
    }

    connection = await createConnection(token);

    const emailRows = await executeQuery(
      connection,
      `SELECT EmailID, MatchedJobID, ReceivedAt FROM Emails WHERE EmailID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: EmailID }],
    );
    const email = emailRows[0];
    if (!email) {
      return { status: 404, jsonBody: { error: "Email not found" } };
    }
    const jobId = email.MatchedJobID as number | null;
    if (!jobId) {
      return {
        status: 400,
        jsonBody: { error: "Email is not matched to a job; set MatchedJobID first." },
      };
    }

    const seqRows = await executeQuery(
      connection,
      "SELECT ISNULL(MAX(Seq), 0) + 1 AS NextSeq FROM Quotes WHERE JobID = @JobID",
      [{ name: "JobID", type: TYPES.Int, value: jobId }],
    );
    const nextSeq = (seqRows[0]?.NextSeq as number) ?? 1;
    const quoteNumber = `QT-${jobId}-${nextSeq}`;

    const inserted = await executeQuery(
      connection,
      `INSERT INTO Quotes
         (JobID, QuoteNumber, Seq, ContractorID, ContractorName, Amount,
          Notes, SourceEmailID, ReceivedAt, CreatedBy)
       OUTPUT INSERTED.QuoteID
       VALUES
         (@JobID, @QuoteNumber, @Seq, @ContractorID, @ContractorName, @Amount,
          @Notes, @EmailID, @ReceivedAt, @CreatedBy);`,
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

app.http("getEmails", { methods: ["GET"], authLevel: "anonymous", handler: getEmails });
app.http("getEmail", { methods: ["GET"], authLevel: "anonymous", handler: getEmail });
app.http("ingestEmail", { methods: ["POST"], authLevel: "anonymous", handler: ingestEmail });
app.http("promoteEmailToQuote", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: promoteEmailToQuote,
});
