// Director decision on a quote — the write paths shared by the in-app
// buttons (quotes.ts: directorApproveQuote / rejectQuote) and the email
// operator flow (emails.ts: recordEmailQuoteDecision). Plain writes on the
// caller's connection: callers own the transaction, the HTTP response, any
// Planner follow-up, and where the actor comes from (never a request body).

import { TYPES } from "tedious";
import type { Connection } from "tedious";
import { executeQuery, type SqlRow } from "./db";

export const QUOTE_COLUMNS = `
  QuoteID, JobID, QuoteNumber, Seq, ContractorID, ContractorName,
  Amount, Currency, Notes, QuotePDFBlobName, SourceEmailID, ReceivedAt,
  Status, ApprovedAt, ApprovedBy, AIValidatedAt, AIValidatedBy,
  CreatedAt, CreatedBy,
  DirectorApprovedAt, DirectorApprovedBy, DirectorEmailSentAt, DirectorEmailSentTo, DirectorEmailSentBy
`;

export interface DirectorQuoteApprovalInput {
  quoteId: number;
  /** Stamped on Quotes.DirectorApprovedBy, Jobs.ApprovedBy and the event. */
  approvedBy: string | null;
  /** Set when the decision was recorded from an inbound email. */
  sourceEmailId?: number;
  /** Director's conditions; appended to the event text. */
  note?: string | null;
}

export interface QuoteRejectionInput {
  quoteId: number;
  rejectedBy: string | null;
  /** Statuses the caller allows a reject from; anything else is a 409. */
  expectedStatuses: readonly string[];
  note?: string | null;
  sourceEmailId?: number;
}

export type QuoteDecisionOutcome =
  | { ok: true; jobId: number; quote: SqlRow; previousStatus?: string }
  | { ok: false; status: 404 | 409; error: string };

const CONCURRENT_CHANGE: QuoteDecisionOutcome = {
  ok: false,
  status: 409,
  error: "Quote status changed concurrently — reload and try again",
};

async function loadQuote(connection: Connection, quoteId: number): Promise<SqlRow> {
  const rows = await executeQuery(
    connection,
    `SELECT ${QUOTE_COLUMNS} FROM Quotes WHERE QuoteID = @Id`,
    [{ name: "Id", type: TYPES.Int, value: quoteId }],
  );
  return rows[0];
}

export async function approveDirectorQuote(
  connection: Connection,
  input: DirectorQuoteApprovalInput,
): Promise<QuoteDecisionOutcome> {
  const { quoteId, approvedBy, sourceEmailId, note } = input;
  const rows = await executeQuery(
    connection,
    `SELECT JobID, QuoteNumber, ContractorName, Status FROM Quotes WHERE QuoteID = @Id`,
    [{ name: "Id", type: TYPES.Int, value: quoteId }],
  );
  if (rows.length === 0) return { ok: false, status: 404, error: "Quote not found" };

  const jobId = rows[0].JobID as number;
  const quoteNumber = (rows[0].QuoteNumber as string | null) ?? `#${quoteId}`;
  const contractorName = rows[0].ContractorName as string | null;
  const status = (rows[0].Status as string) ?? "";

  if (status === "approved") {
    return { ok: false, status: 409, error: "Quote is already fully approved" };
  }
  if (status !== "awaiting_director") {
    return { ok: false, status: 409, error: "Quote must be in awaiting_director state" };
  }

  const updated = await executeQuery(
    connection,
    `UPDATE Quotes
       SET Status = 'approved',
           DirectorApprovedAt = SYSUTCDATETIME(),
           DirectorApprovedBy = @ApprovedBy
     OUTPUT inserted.QuoteID
     WHERE QuoteID = @Id AND Status = 'awaiting_director'`,
    [
      { name: "Id", type: TYPES.Int, value: quoteId },
      { name: "ApprovedBy", type: TYPES.NVarChar, value: approvedBy },
    ],
  );
  if (updated.length === 0) return CONCURRENT_CHANGE;

  await executeQuery(
    connection,
    `UPDATE Jobs
       SET ApprovedQuoteID = @QuoteID,
           ApprovedBy = @ApprovedBy,
           ApprovedAt = SYSUTCDATETIME(),
           LastModifiedDate = SYSUTCDATETIME()
     WHERE JobID = @JobID`,
    [
      { name: "QuoteID", type: TYPES.Int, value: quoteId },
      { name: "JobID", type: TYPES.Int, value: jobId },
      { name: "ApprovedBy", type: TYPES.NVarChar, value: approvedBy },
    ],
  );
  const via = sourceEmailId == null ? "" : " via email";
  const conditions = note && note.trim().length > 0 ? ` — ${note.trim()}` : "";
  await executeQuery(
    connection,
    `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, QuoteID, SourceEmailID)
     VALUES (@JobID, @CreatedBy, @Text, 'quote_director_approved', @QuoteID, @SourceEmailID);`,
    [
      { name: "JobID", type: TYPES.Int, value: jobId },
      { name: "CreatedBy", type: TYPES.NVarChar, value: approvedBy },
      {
        name: "Text",
        type: TYPES.NVarChar,
        value: `Director-approved ${quoteNumber}${contractorName ? ` from ${contractorName}` : ""}${via}${conditions}`,
      },
      { name: "QuoteID", type: TYPES.Int, value: quoteId },
      { name: "SourceEmailID", type: TYPES.Int, value: sourceEmailId ?? null },
    ],
  );

  return { ok: true, jobId, quote: await loadQuote(connection, quoteId) };
}

export async function rejectQuote(
  connection: Connection,
  input: QuoteRejectionInput,
): Promise<QuoteDecisionOutcome> {
  const { quoteId, rejectedBy, expectedStatuses, note, sourceEmailId } = input;
  const rows = await executeQuery(
    connection,
    "SELECT JobID, QuoteNumber, Status FROM Quotes WHERE QuoteID = @Id",
    [{ name: "Id", type: TYPES.Int, value: quoteId }],
  );
  if (rows.length === 0) return { ok: false, status: 404, error: "Quote not found" };

  const jobId = rows[0].JobID as number;
  const quoteNumber = (rows[0].QuoteNumber as string | null) ?? `#${quoteId}`;
  const status = (rows[0].Status as string | null) ?? "";
  if (!expectedStatuses.includes(status)) {
    return {
      ok: false,
      status: 409,
      error: `Quote is ${status || "in an unknown state"} — it can only be rejected while ${expectedStatuses.join(" or ")}`,
    };
  }

  const updated = await executeQuery(
    connection,
    `UPDATE Quotes SET Status = 'rejected'
     OUTPUT inserted.QuoteID
     WHERE QuoteID = @Id AND Status = @CurrentStatus`,
    [
      { name: "Id", type: TYPES.Int, value: quoteId },
      { name: "CurrentStatus", type: TYPES.NVarChar, value: status },
    ],
  );
  if (updated.length === 0) return CONCURRENT_CHANGE;

  const via = sourceEmailId == null ? "" : " via email";
  const reason = note && note.trim().length > 0 ? ` — ${note.trim()}` : "";
  await executeQuery(
    connection,
    `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, QuoteID, SourceEmailID)
     VALUES (@JobID, @CreatedBy, @Text, 'quote_rejected', @QuoteID, @SourceEmailID);`,
    [
      { name: "JobID", type: TYPES.Int, value: jobId },
      { name: "CreatedBy", type: TYPES.NVarChar, value: rejectedBy },
      { name: "Text", type: TYPES.NVarChar, value: `Rejected quote ${quoteNumber}${via}${reason}` },
      { name: "QuoteID", type: TYPES.Int, value: quoteId },
      { name: "SourceEmailID", type: TYPES.Int, value: sourceEmailId ?? null },
    ],
  );
  await executeQuery(
    connection,
    "UPDATE Jobs SET LastModifiedDate = SYSUTCDATETIME() WHERE JobID = @JobID",
    [{ name: "JobID", type: TYPES.Int, value: jobId }],
  );

  return { ok: true, jobId, previousStatus: status, quote: await loadQuote(connection, quoteId) };
}
