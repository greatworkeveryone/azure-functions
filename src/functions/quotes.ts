// Quotes — CRUD + approve/reject. A contractor replies to a PO email and
// we materialise their quote here. Approving a quote sets Jobs.ApprovedQuoteID
// and stamps ApprovedBy/ApprovedAt so the Payment step has everything it needs.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import {
  beginTransaction,
  closeConnection,
  commitTransaction,
  createConnection,
  executeQuery,
  rollbackTransaction,
} from "../db";
import { extractToken, unauthorizedResponse, errorResponse } from "../auth";
import {
  INTERNAL_ACRONYM,
  ensureContractorAcronym,
} from "../contractor-acronym-db";
import { formatDocNumber } from "../doc-number";

const QUOTE_COLUMNS = `
  QuoteID, JobID, QuoteNumber, Seq, ContractorID, ContractorName,
  Amount, Currency, Notes, QuotePDFBlobName, SourceEmailID, ReceivedAt,
  Status, ApprovedAt, ApprovedBy, AIValidatedAt, AIValidatedBy,
  CreatedAt, CreatedBy
`;

// ── GET /api/getQuotes[?jobId=N][&status=pending|approved|rejected] ─────────

async function getQuotes(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const jobId = request.query.get("jobId");
  const status = request.query.get("status");

  const whereParts: string[] = [];
  const params: { name: string; type: any; value: any }[] = [];
  if (jobId) {
    whereParts.push("JobID = @JobID");
    params.push({ name: "JobID", type: TYPES.Int, value: Number(jobId) });
  }
  if (status) {
    whereParts.push("Status = @Status");
    params.push({ name: "Status", type: TYPES.NVarChar, value: status });
  }
  const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

  let connection;
  try {
    connection = await createConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT ${QUOTE_COLUMNS} FROM Quotes ${where} ORDER BY CreatedAt DESC`,
      params,
    );
    return { status: 200, jsonBody: { count: rows.length, quotes: rows } };
  } catch (error: any) {
    context.error("getQuotes failed:", error.message);
    return errorResponse("Failed to fetch quotes", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/upsertQuote ────────────────────────────────────────────────────

async function upsertQuote(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const {
      QuoteID,
      JobID,
      ContractorID,
      ContractorName,
      Amount,
      Currency,
      Notes,
      QuotePDFBlobName,
      SourceEmailID,
      ReceivedAt,
      CreatedBy,
    } = body ?? {};

    connection = await createConnection(token);

    if (QuoteID === undefined) {
      // Create — runs in a tx so the SELECT MAX(Seq) + INSERT pair is atomic.
      if (typeof JobID !== "number") {
        return { status: 400, jsonBody: { error: "JobID (number) required to create a quote" } };
      }

      await beginTransaction(connection);
      try {
        const acronym =
          typeof ContractorID === "number"
            ? await ensureContractorAcronym(connection, ContractorID)
            : INTERNAL_ACRONYM;

        const seqSql =
          typeof ContractorID === "number"
            ? `SELECT ISNULL(MAX(Seq), 0) + 1 AS NextSeq
                 FROM Quotes WITH (UPDLOCK, HOLDLOCK)
                WHERE ContractorID = @ContractorID`
            : `SELECT ISNULL(MAX(Seq), 0) + 1 AS NextSeq
                 FROM Quotes WITH (UPDLOCK, HOLDLOCK)
                WHERE JobID = @JobID AND ContractorID IS NULL`;
        const seqParams =
          typeof ContractorID === "number"
            ? [{ name: "ContractorID", type: TYPES.Int, value: ContractorID }]
            : [{ name: "JobID", type: TYPES.Int, value: JobID }];
        const seqRows = await executeQuery(connection, seqSql, seqParams);
        const nextSeq = (seqRows[0]?.NextSeq as number) ?? 1;

        const quoteNumber = formatDocNumber({
          prefix: "Q",
          jobId: JobID,
          acronym,
          seq: nextSeq,
        });

        const inserted = await executeQuery(
          connection,
          `INSERT INTO Quotes
             (JobID, QuoteNumber, Seq, ContractorID, ContractorName, Amount,
              Currency, Notes, QuotePDFBlobName, SourceEmailID, ReceivedAt, CreatedBy)
           OUTPUT INSERTED.QuoteID
           VALUES
             (@JobID, @QuoteNumber, @Seq, @ContractorID, @ContractorName, @Amount,
              @Currency, @Notes, @QuotePDFBlobName, @SourceEmailID, @ReceivedAt, @CreatedBy);`,
          [
            { name: "JobID", type: TYPES.Int, value: JobID },
            { name: "QuoteNumber", type: TYPES.NVarChar, value: quoteNumber },
            { name: "Seq", type: TYPES.Int, value: nextSeq },
            { name: "ContractorID", type: TYPES.Int, value: ContractorID ?? null },
            { name: "ContractorName", type: TYPES.NVarChar, value: ContractorName ?? null },
            { name: "Amount", type: TYPES.Decimal, value: Amount ?? null },
            { name: "Currency", type: TYPES.NVarChar, value: Currency ?? "AUD" },
            { name: "Notes", type: TYPES.NVarChar, value: Notes ?? null },
            { name: "QuotePDFBlobName", type: TYPES.NVarChar, value: QuotePDFBlobName ?? null },
            { name: "SourceEmailID", type: TYPES.Int, value: SourceEmailID ?? null },
            { name: "ReceivedAt", type: TYPES.DateTime2, value: ReceivedAt ?? null },
            { name: "CreatedBy", type: TYPES.NVarChar, value: CreatedBy ?? null },
          ],
        );
        const newId = inserted[0].QuoteID as number;

        // Mirror onto the job's activity feed. Kept inside the tx so the
        // quote + its creation event land atomically; if the event insert
        // fails we don't ship a ghost quote with no history trail.
        const amountLabel =
          typeof Amount === "number"
            ? ` · $${Number(Amount).toLocaleString()}`
            : "";
        const contractorLabel = ContractorName ? ` · ${ContractorName}` : "";
        await executeQuery(
          connection,
          `INSERT INTO JobEvents
             (JobID, CreatedBy, [Text], EventType, QuoteID)
           VALUES (@JobID, @CreatedBy, @Text, 'quote_added', @QuoteID);`,
          [
            { name: "JobID", type: TYPES.Int, value: JobID },
            { name: "CreatedBy", type: TYPES.NVarChar, value: CreatedBy ?? null },
            {
              name: "Text",
              type: TYPES.NVarChar,
              value: `Added quote ${quoteNumber}${contractorLabel}${amountLabel}`,
            },
            { name: "QuoteID", type: TYPES.Int, value: newId },
          ],
        );
        await executeQuery(
          connection,
          "UPDATE Jobs SET LastModifiedDate = SYSUTCDATETIME() WHERE JobID = @JobID",
          [{ name: "JobID", type: TYPES.Int, value: JobID }],
        );

        await commitTransaction(connection);

        const stored = await executeQuery(
          connection,
          `SELECT ${QUOTE_COLUMNS} FROM Quotes WHERE QuoteID = @Id`,
          [{ name: "Id", type: TYPES.Int, value: newId }],
        );
        return { status: 200, jsonBody: { quote: stored[0] } };
      } catch (err) {
        await rollbackTransaction(connection).catch(() => {});
        throw err;
      }
    }

    // Update
    if (typeof QuoteID !== "number") {
      return { status: 400, jsonBody: { error: "QuoteID must be a number" } };
    }
    const fields: string[] = [];
    const params: { name: string; type: any; value: any }[] = [
      { name: "Id", type: TYPES.Int, value: QuoteID },
    ];
    const push = (col: string, type: any, val: unknown) => {
      fields.push(`${col} = @${col}`);
      params.push({ name: col, type, value: val ?? null });
    };
    if (ContractorID !== undefined) push("ContractorID", TYPES.Int, ContractorID);
    if (ContractorName !== undefined) push("ContractorName", TYPES.NVarChar, ContractorName);
    if (Amount !== undefined) push("Amount", TYPES.Decimal, Amount);
    if (Currency !== undefined) push("Currency", TYPES.NVarChar, Currency);
    if (Notes !== undefined) push("Notes", TYPES.NVarChar, Notes);
    if (QuotePDFBlobName !== undefined) push("QuotePDFBlobName", TYPES.NVarChar, QuotePDFBlobName);

    if (fields.length === 0) {
      return { status: 400, jsonBody: { error: "No fields to update" } };
    }

    await executeQuery(
      connection,
      `UPDATE Quotes SET ${fields.join(", ")} WHERE QuoteID = @Id`,
      params,
    );
    const stored = await executeQuery(
      connection,
      `SELECT ${QUOTE_COLUMNS} FROM Quotes WHERE QuoteID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: QuoteID }],
    );
    if (stored.length === 0) {
      return { status: 404, jsonBody: { error: "Quote not found" } };
    }
    return { status: 200, jsonBody: { quote: stored[0] } };
  } catch (error: any) {
    context.error("upsertQuote failed:", error.message);
    return errorResponse("Upsert quote failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/approveQuote ───────────────────────────────────────────────────
// Body: { QuoteID, ApprovedBy }
// Sets Quotes.Status='approved' + ApprovedBy/ApprovedAt, and mirrors the id
// onto Jobs.ApprovedQuoteID / ApprovedBy / ApprovedAt so the Payment step
// sees the approval without re-reading the Quotes table.

async function approveQuote(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const { QuoteID, ApprovedBy } = body ?? {};
    if (typeof QuoteID !== "number") {
      return { status: 400, jsonBody: { error: "QuoteID (number) required" } };
    }

    connection = await createConnection(token);

    // Find parent job + quote number + contractor (used on the job's activity feed).
    const quoteRows = await executeQuery(
      connection,
      "SELECT JobID, QuoteNumber, ContractorName FROM Quotes WHERE QuoteID = @Id",
      [{ name: "Id", type: TYPES.Int, value: QuoteID }],
    );
    if (quoteRows.length === 0) {
      return { status: 404, jsonBody: { error: "Quote not found" } };
    }
    const jobId = quoteRows[0].JobID as number;
    const quoteNumber = (quoteRows[0].QuoteNumber as string | null) ?? `#${QuoteID}`;
    const contractorName = quoteRows[0].ContractorName as string | null;

    await executeQuery(
      connection,
      `UPDATE Quotes
       SET Status = 'approved', ApprovedAt = SYSUTCDATETIME(), ApprovedBy = @ApprovedBy
       WHERE QuoteID = @Id`,
      [
        { name: "Id", type: TYPES.Int, value: QuoteID },
        { name: "ApprovedBy", type: TYPES.NVarChar, value: ApprovedBy ?? null },
      ],
    );
    await executeQuery(
      connection,
      `UPDATE Jobs
       SET ApprovedQuoteID = @QuoteID,
           ApprovedBy = @ApprovedBy,
           ApprovedAt = SYSUTCDATETIME(),
           LastModifiedDate = SYSUTCDATETIME()
       WHERE JobID = @JobID`,
      [
        { name: "QuoteID", type: TYPES.Int, value: QuoteID },
        { name: "JobID", type: TYPES.Int, value: jobId },
        { name: "ApprovedBy", type: TYPES.NVarChar, value: ApprovedBy ?? null },
      ],
    );
    await executeQuery(
      connection,
      `INSERT INTO JobEvents
         (JobID, CreatedBy, [Text], EventType, QuoteID)
       VALUES (@JobID, @CreatedBy, @Text, 'quote_approved', @QuoteID);`,
      [
        { name: "JobID", type: TYPES.Int, value: jobId },
        { name: "CreatedBy", type: TYPES.NVarChar, value: ApprovedBy ?? null },
        {
          name: "Text",
          type: TYPES.NVarChar,
          value: `Approved ${quoteNumber}${contractorName ? ` from ${contractorName}` : ""}`,
        },
        { name: "QuoteID", type: TYPES.Int, value: QuoteID },
      ],
    );

    const stored = await executeQuery(
      connection,
      `SELECT ${QUOTE_COLUMNS} FROM Quotes WHERE QuoteID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: QuoteID }],
    );
    return { status: 200, jsonBody: { quote: stored[0] } };
  } catch (error: any) {
    context.error("approveQuote failed:", error.message);
    return errorResponse("Approve quote failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/rejectQuote ────────────────────────────────────────────────────

async function rejectQuote(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const { QuoteID, RejectedBy } = body ?? {};
    if (typeof QuoteID !== "number") {
      return { status: 400, jsonBody: { error: "QuoteID (number) required" } };
    }

    connection = await createConnection(token);

    // Fetch parent job + quote number for the history event before we mutate.
    const quoteRows = await executeQuery(
      connection,
      "SELECT JobID, QuoteNumber FROM Quotes WHERE QuoteID = @Id",
      [{ name: "Id", type: TYPES.Int, value: QuoteID }],
    );
    if (quoteRows.length === 0) {
      return { status: 404, jsonBody: { error: "Quote not found" } };
    }
    const jobId = quoteRows[0].JobID as number;
    const quoteNumber = (quoteRows[0].QuoteNumber as string | null) ?? `#${QuoteID}`;

    await executeQuery(
      connection,
      "UPDATE Quotes SET Status = 'rejected' WHERE QuoteID = @Id",
      [{ name: "Id", type: TYPES.Int, value: QuoteID }],
    );
    await executeQuery(
      connection,
      `INSERT INTO JobEvents
         (JobID, CreatedBy, [Text], EventType, QuoteID)
       VALUES (@JobID, @CreatedBy, @Text, 'quote_rejected', @QuoteID);`,
      [
        { name: "JobID", type: TYPES.Int, value: jobId },
        { name: "CreatedBy", type: TYPES.NVarChar, value: RejectedBy ?? null },
        {
          name: "Text",
          type: TYPES.NVarChar,
          value: `Rejected quote ${quoteNumber}`,
        },
        { name: "QuoteID", type: TYPES.Int, value: QuoteID },
      ],
    );
    await executeQuery(
      connection,
      "UPDATE Jobs SET LastModifiedDate = SYSUTCDATETIME() WHERE JobID = @JobID",
      [{ name: "JobID", type: TYPES.Int, value: jobId }],
    );
    const stored = await executeQuery(
      connection,
      `SELECT ${QUOTE_COLUMNS} FROM Quotes WHERE QuoteID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: QuoteID }],
    );
    return { status: 200, jsonBody: { quote: stored[0] } };
  } catch (error: any) {
    context.error("rejectQuote failed:", error.message);
    return errorResponse("Reject quote failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/unapproveQuote ─────────────────────────────────────────────────
// Body: { QuoteID, UnapprovedBy }
// Reverts an approved quote back to 'pending' — clears Quote approval
// stamps, nulls Jobs.ApprovedQuoteID (only if this quote was the approved
// one — guards against a race where a different quote got approved in the
// meantime), and logs an event. Refused if any Payment has been recorded
// against the quote: money has moved, unapproval is no longer safe.

async function unapproveQuote(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const { QuoteID, UnapprovedBy } = body ?? {};
    if (typeof QuoteID !== "number") {
      return { status: 400, jsonBody: { error: "QuoteID (number) required" } };
    }

    connection = await createConnection(token);

    const rows = await executeQuery(
      connection,
      "SELECT JobID, QuoteNumber, Status FROM Quotes WHERE QuoteID = @Id",
      [{ name: "Id", type: TYPES.Int, value: QuoteID }],
    );
    if (rows.length === 0) {
      return { status: 404, jsonBody: { error: "Quote not found" } };
    }
    if (rows[0].Status !== "approved") {
      return {
        status: 400,
        jsonBody: { error: "Only approved quotes can be unapproved." },
      };
    }
    const jobId = rows[0].JobID as number;
    const quoteNumber =
      (rows[0].QuoteNumber as string | null) ?? `#${QuoteID}`;

    const paymentCount = await executeQuery(
      connection,
      "SELECT COUNT(*) AS N FROM Payments WHERE QuoteID = @Id",
      [{ name: "Id", type: TYPES.Int, value: QuoteID }],
    );
    if ((paymentCount[0]?.N as number) > 0) {
      return {
        status: 400,
        jsonBody: {
          error:
            "Cannot unapprove — a payment has already been recorded against this quote.",
        },
      };
    }

    await executeQuery(
      connection,
      `UPDATE Quotes
         SET Status = 'pending', ApprovedAt = NULL, ApprovedBy = NULL
       WHERE QuoteID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: QuoteID }],
    );
    await executeQuery(
      connection,
      `UPDATE Jobs
         SET ApprovedQuoteID = NULL, ApprovedBy = NULL, ApprovedAt = NULL,
             LastModifiedDate = SYSUTCDATETIME()
       WHERE JobID = @JobID AND ApprovedQuoteID = @QuoteID`,
      [
        { name: "JobID", type: TYPES.Int, value: jobId },
        { name: "QuoteID", type: TYPES.Int, value: QuoteID },
      ],
    );
    await executeQuery(
      connection,
      `INSERT INTO JobEvents
         (JobID, CreatedBy, [Text], EventType, QuoteID)
       VALUES (@JobID, @CreatedBy, @Text, 'quote_unapproved', @QuoteID);`,
      [
        { name: "JobID", type: TYPES.Int, value: jobId },
        { name: "CreatedBy", type: TYPES.NVarChar, value: UnapprovedBy ?? null },
        {
          name: "Text",
          type: TYPES.NVarChar,
          value: `Unapproved quote ${quoteNumber}`,
        },
        { name: "QuoteID", type: TYPES.Int, value: QuoteID },
      ],
    );

    const stored = await executeQuery(
      connection,
      `SELECT ${QUOTE_COLUMNS} FROM Quotes WHERE QuoteID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: QuoteID }],
    );
    return { status: 200, jsonBody: { quote: stored[0] } };
  } catch (error: any) {
    context.error("unapproveQuote failed:", error.message);
    return errorResponse("Unapprove quote failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/deleteQuote ────────────────────────────────────────────────────
// Body: { QuoteID }
// Refuses to delete approved quotes — Jobs.ApprovedQuoteID still references
// them and a payment may have been recorded against the approval. User
// should reject first, then delete if needed.

async function deleteQuote(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const { QuoteID } = body ?? {};
    if (typeof QuoteID !== "number") {
      return { status: 400, jsonBody: { error: "QuoteID (number) required" } };
    }

    connection = await createConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT Status FROM Quotes WHERE QuoteID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: QuoteID }],
    );
    if (rows.length === 0) {
      return { status: 404, jsonBody: { error: "Quote not found" } };
    }
    if (rows[0].Status === "approved") {
      return {
        status: 400,
        jsonBody: {
          error: "Cannot delete an approved quote. Reject it first if needed.",
        },
      };
    }

    await executeQuery(
      connection,
      `DELETE FROM Quotes WHERE QuoteID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: QuoteID }],
    );

    return { status: 200, jsonBody: { deleted: true, quoteId: QuoteID } };
  } catch (error: any) {
    context.error("deleteQuote failed:", error.message);
    return errorResponse("Delete quote failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/validateQuote ──────────────────────────────────────────────────
// Body: { QuoteID, ValidatedBy }
// Stamps AIValidatedAt / AIValidatedBy so the UI's "AI Generated — must be
// validated" tag clears. Idempotent: re-validating just refreshes the
// timestamp and validator.

async function validateQuote(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const { QuoteID, ValidatedBy } = body ?? {};
    if (typeof QuoteID !== "number") {
      return { status: 400, jsonBody: { error: "QuoteID (number) required" } };
    }

    connection = await createConnection(token);

    const quoteRows = await executeQuery(
      connection,
      "SELECT JobID, QuoteNumber FROM Quotes WHERE QuoteID = @Id",
      [{ name: "Id", type: TYPES.Int, value: QuoteID }],
    );
    if (quoteRows.length === 0) {
      return { status: 404, jsonBody: { error: "Quote not found" } };
    }
    const jobId = quoteRows[0].JobID as number;
    const quoteNumber = (quoteRows[0].QuoteNumber as string | null) ?? `#${QuoteID}`;

    await executeQuery(
      connection,
      `UPDATE Quotes
       SET AIValidatedAt = SYSUTCDATETIME(), AIValidatedBy = @ValidatedBy
       WHERE QuoteID = @Id`,
      [
        { name: "Id", type: TYPES.Int, value: QuoteID },
        { name: "ValidatedBy", type: TYPES.NVarChar, value: ValidatedBy ?? null },
      ],
    );
    await executeQuery(
      connection,
      `INSERT INTO JobEvents
         (JobID, CreatedBy, [Text], EventType, QuoteID)
       VALUES (@JobID, @CreatedBy, @Text, 'comment', @QuoteID);`,
      [
        { name: "JobID", type: TYPES.Int, value: jobId },
        { name: "CreatedBy", type: TYPES.NVarChar, value: ValidatedBy ?? null },
        {
          name: "Text",
          type: TYPES.NVarChar,
          value: `Validated AI-parsed quote ${quoteNumber}`,
        },
        { name: "QuoteID", type: TYPES.Int, value: QuoteID },
      ],
    );
    await executeQuery(
      connection,
      "UPDATE Jobs SET LastModifiedDate = SYSUTCDATETIME() WHERE JobID = @JobID",
      [{ name: "JobID", type: TYPES.Int, value: jobId }],
    );

    const stored = await executeQuery(
      connection,
      `SELECT ${QUOTE_COLUMNS} FROM Quotes WHERE QuoteID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: QuoteID }],
    );
    return { status: 200, jsonBody: { quote: stored[0] } };
  } catch (error: any) {
    context.error("validateQuote failed:", error.message);
    return errorResponse("Validate quote failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getQuotes", { methods: ["GET"], authLevel: "anonymous", handler: getQuotes });
app.http("upsertQuote", { methods: ["POST"], authLevel: "anonymous", handler: upsertQuote });
app.http("approveQuote", { methods: ["POST"], authLevel: "anonymous", handler: approveQuote });
app.http("rejectQuote", { methods: ["POST"], authLevel: "anonymous", handler: rejectQuote });
app.http("deleteQuote", { methods: ["POST"], authLevel: "anonymous", handler: deleteQuote });
app.http("unapproveQuote", { methods: ["POST"], authLevel: "anonymous", handler: unapproveQuote });
app.http("validateQuote", { methods: ["POST"], authLevel: "anonymous", handler: validateQuote });
