import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { buildUpdateSet, createConnection, executeQuery, closeConnection, beginTransaction, commitTransaction, rollbackTransaction } from "../db";
import { fetchInvoices, MyInvoice } from "../mybuildings-client";
import { extractToken, unauthorizedResponse, errorResponse } from "../auth";
import { TYPES } from "tedious";
import { formatYYMMDD } from "../doc-number";

// POST /api/syncInvoices - fetch from myBuildings and upsert into SQL
async function syncInvoices(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = await request.json() as any;
    const params = body.queryParams || "";

    if (!params) {
      return { status: 400, jsonBody: { error: "queryParams required (e.g. statusid=17 or minimumdateapproved=2024-01-01)" } };
    }

    context.log("Fetching invoices from myBuildings API...");
    const invoices = await fetchInvoices(params);
    context.log(`Fetched ${invoices.length} invoices`);

    connection = await createConnection(token);
    let inserted = 0;
    let updated = 0;

    for (const inv of invoices) {
      const existing = await executeQuery(connection,
        "SELECT Id FROM Invoices WHERE InvoiceID = @InvoiceID",
        [{ name: "InvoiceID", type: TYPES.Int, value: inv.InvoiceID }]
      );

      const p = invoiceToParams(inv);

      if (existing.length > 0) {
        await executeQuery(connection,
          `UPDATE Invoices SET
           InvoiceNumber=@InvoiceNumber, WorkRequestID=@WorkRequestID, JobCode=@JobCode,
           BuildingName=@BuildingName, BuildingID=@BuildingID,
           ContractorName=@ContractorName, ContractorID=@ContractorID,
           InvoiceAmount=@InvoiceAmount, GSTAmount=@GSTAmount, TotalAmount=@TotalAmount,
           InvoiceDate=@InvoiceDate, DateApproved=@DateApproved,
           StatusID=@StatusID, Status=@Status, InvoicePDFURL=@InvoicePDFURL,
           GLAccountCode=@GLAccountCode,
           LastSyncedAt=GETUTCDATE(), UpdatedAt=GETUTCDATE()
           WHERE InvoiceID=@InvoiceID`, p);
        updated++;
      } else {
        await executeQuery(connection,
          `INSERT INTO Invoices (InvoiceID, InvoiceNumber, WorkRequestID, JobCode,
           BuildingName, BuildingID, ContractorName, ContractorID,
           InvoiceAmount, GSTAmount, TotalAmount, InvoiceDate, DateApproved,
           StatusID, Status, InvoicePDFURL, GLAccountCode,
           LastSyncedAt, CreatedAt, UpdatedAt)
           VALUES (@InvoiceID, @InvoiceNumber, @WorkRequestID, @JobCode,
           @BuildingName, @BuildingID, @ContractorName, @ContractorID,
           @InvoiceAmount, @GSTAmount, @TotalAmount, @InvoiceDate, @DateApproved,
           @StatusID, @Status, @InvoicePDFURL, @GLAccountCode,
           GETUTCDATE(), GETUTCDATE(), GETUTCDATE())`, p);
        inserted++;
      }
    }

    return { status: 200, jsonBody: { message: "Sync complete", total: invoices.length, inserted, updated } };
  } catch (error: any) {
    context.error("Sync failed:", error.message);
    return errorResponse("Sync failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// GET /api/getInvoices - query from local database
async function getInvoices(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    connection = await createConnection(token);

    const buildingId = request.query.get("buildingId");
    const statusId = request.query.get("statusId");
    const jobCode = request.query.get("jobCode");

    let sql = "SELECT * FROM Invoices WHERE 1=1";
    const params: any[] = [];

    if (buildingId) {
      sql += " AND BuildingID = @BuildingID";
      params.push({ name: "BuildingID", type: TYPES.Int, value: parseInt(buildingId) });
    }
    if (statusId) {
      sql += " AND StatusID = @StatusID";
      params.push({ name: "StatusID", type: TYPES.Int, value: parseInt(statusId) });
    }
    if (jobCode) {
      sql += " AND JobCode = @JobCode";
      params.push({ name: "JobCode", type: TYPES.NVarChar, value: jobCode });
    }

    sql += " ORDER BY InvoiceDate DESC";
    const rows = await executeQuery(connection, sql, params);

    return { status: 200, jsonBody: { invoices: rows, count: rows.length } };
  } catch (error: any) {
    context.error("Query failed:", error.message);
    return errorResponse("Query failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

function invoiceToParams(inv: MyInvoice) {
  return [
    { name: "InvoiceID", type: TYPES.Int, value: inv.InvoiceID ?? null },
    { name: "InvoiceNumber", type: TYPES.NVarChar, value: inv.InvoiceNumber ?? null },
    { name: "WorkRequestID", type: TYPES.Int, value: inv.WorkRequestID ?? null },
    { name: "JobCode", type: TYPES.NVarChar, value: inv.JobCode ?? null },
    { name: "BuildingName", type: TYPES.NVarChar, value: inv.BuildingName ?? null },
    { name: "BuildingID", type: TYPES.Int, value: inv.BuildingID ?? null },
    { name: "ContractorName", type: TYPES.NVarChar, value: inv.ContractorName ?? null },
    { name: "ContractorID", type: TYPES.Int, value: inv.ContractorID ?? null },
    { name: "InvoiceAmount", type: TYPES.Decimal, value: inv.InvoiceAmount ?? null },
    { name: "GSTAmount", type: TYPES.Decimal, value: inv.GSTAmount ?? null },
    { name: "TotalAmount", type: TYPES.Decimal, value: inv.TotalAmount ?? null },
    { name: "InvoiceDate", type: TYPES.NVarChar, value: inv.InvoiceDate ?? null },
    { name: "DateApproved", type: TYPES.NVarChar, value: inv.DateApproved ?? null },
    { name: "StatusID", type: TYPES.Int, value: inv.StatusID ?? null },
    { name: "Status", type: TYPES.NVarChar, value: inv.Status ?? null },
    { name: "InvoicePDFURL", type: TYPES.NVarChar, value: inv.InvoicePDFURL ?? null },
    { name: "GLAccountCode", type: TYPES.NVarChar, value: inv.GLAccountCode ?? null },
  ];
}

app.http("syncInvoices", { methods: ["POST"], authLevel: "anonymous", handler: syncInvoices });
app.http("getInvoices", { methods: ["GET"], authLevel: "anonymous", handler: getInvoices });

// ─────────────────────────────────────────────────────────────────────────────
// Job-linked invoices — attached to a Job for accounts-team review.
// Uses the JobInvoices table (separate from the myBuildings Invoices sync).
// ─────────────────────────────────────────────────────────────────────────────

const JOB_INVOICE_COLUMNS = `
  JobInvoiceID, JobID, InvoiceNumber, Seq, ContractorName,
  Amount, Currency, Notes, InvoicePDFBlobName, SourceEmailID, ReceivedAt,
  Status, ApprovedAt, ApprovedBy, CreatedAt, CreatedBy
`;

// ── GET /api/getJobInvoices?jobId=N ──────────────────────────────────────────

async function getJobInvoices(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const jobId = request.query.get("jobId");
  if (!jobId) return { status: 400, jsonBody: { error: "jobId query param required" } };

  let connection;
  try {
    connection = await createConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT ${JOB_INVOICE_COLUMNS} FROM JobInvoices WHERE JobID = @JobID ORDER BY CreatedAt DESC`,
      [{ name: "JobID", type: TYPES.Int, value: Number(jobId) }],
    );
    return { status: 200, jsonBody: { count: rows.length, invoices: rows } };
  } catch (error: any) {
    context.error("getJobInvoices failed:", error.message);
    return errorResponse("Failed to fetch invoices", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/upsertJobInvoice ────────────────────────────────────────────────
// Body: { JobInvoiceID?, JobID (required on create), ContractorName?, Amount?,
//         Currency?, Notes?, InvoicePDFBlobName?, SourceEmailID?, ReceivedAt?, CreatedBy? }

async function upsertJobInvoice(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const {
      JobInvoiceID,
      JobID,
      ContractorName,
      Amount,
      Currency,
      Notes,
      InvoicePDFBlobName,
      SourceEmailID,
      ReceivedAt,
      CreatedBy,
    } = body ?? {};

    connection = await createConnection(token);

    if (JobInvoiceID === undefined) {
      if (typeof JobID !== "number") {
        return { status: 400, jsonBody: { error: "JobID (number) required to create an invoice" } };
      }

      await beginTransaction(connection);
      try {
        const seqRows = await executeQuery(
          connection,
          `SELECT ISNULL(MAX(Seq), 0) + 1 AS NextSeq FROM JobInvoices WITH (UPDLOCK, HOLDLOCK) WHERE JobID = @JobID`,
          [{ name: "JobID", type: TYPES.Int, value: JobID }],
        );
        const nextSeq = (seqRows[0]?.NextSeq as number) ?? 1;
        const invoiceNumber = `${formatYYMMDD()}-INV-${JobID}-${nextSeq}`;

        const inserted = await executeQuery(
          connection,
          `INSERT INTO JobInvoices
             (JobID, InvoiceNumber, Seq, ContractorName, Amount, Currency,
              Notes, InvoicePDFBlobName, SourceEmailID, ReceivedAt, CreatedBy)
           OUTPUT INSERTED.JobInvoiceID
           VALUES
             (@JobID, @InvoiceNumber, @Seq, @ContractorName, @Amount, @Currency,
              @Notes, @InvoicePDFBlobName, @SourceEmailID, @ReceivedAt, @CreatedBy);`,
          [
            { name: "JobID", type: TYPES.Int, value: JobID },
            { name: "InvoiceNumber", type: TYPES.NVarChar, value: invoiceNumber },
            { name: "Seq", type: TYPES.Int, value: nextSeq },
            { name: "ContractorName", type: TYPES.NVarChar, value: ContractorName ?? null },
            { name: "Amount", type: TYPES.Decimal, value: Amount ?? null },
            { name: "Currency", type: TYPES.NVarChar, value: Currency ?? "AUD" },
            { name: "Notes", type: TYPES.NVarChar, value: Notes ?? null },
            { name: "InvoicePDFBlobName", type: TYPES.NVarChar, value: InvoicePDFBlobName ?? null },
            { name: "SourceEmailID", type: TYPES.Int, value: SourceEmailID ?? null },
            { name: "ReceivedAt", type: TYPES.DateTime2, value: ReceivedAt ?? null },
            { name: "CreatedBy", type: TYPES.NVarChar, value: CreatedBy ?? null },
          ],
        );
        const newId = inserted[0].JobInvoiceID as number;

        const amountLabel = typeof Amount === "number" ? ` · $${Number(Amount).toLocaleString()}` : "";
        const contractorLabel = ContractorName ? ` · ${ContractorName}` : "";
        await executeQuery(
          connection,
          `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, InvoiceID)
           VALUES (@JobID, @CreatedBy, @Text, 'invoice_added', @InvoiceID);`,
          [
            { name: "JobID", type: TYPES.Int, value: JobID },
            { name: "CreatedBy", type: TYPES.NVarChar, value: CreatedBy ?? null },
            { name: "Text", type: TYPES.NVarChar, value: `Added invoice ${invoiceNumber}${contractorLabel}${amountLabel}` },
            { name: "InvoiceID", type: TYPES.Int, value: newId },
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
          `SELECT ${JOB_INVOICE_COLUMNS} FROM JobInvoices WHERE JobInvoiceID = @Id`,
          [{ name: "Id", type: TYPES.Int, value: newId }],
        );
        return { status: 200, jsonBody: { invoice: stored[0] } };
      } catch (err) {
        await rollbackTransaction(connection).catch(() => {});
        throw err;
      }
    }

    // Update
    if (typeof JobInvoiceID !== "number") {
      return { status: 400, jsonBody: { error: "JobInvoiceID must be a number" } };
    }
    const update = buildUpdateSet(
      {
        Amount: TYPES.Decimal,
        ContractorName: TYPES.NVarChar,
        Currency: TYPES.NVarChar,
        InvoicePDFBlobName: TYPES.NVarChar,
        Notes: TYPES.NVarChar,
        ReceivedAt: TYPES.DateTime2,
      },
      { Amount, ContractorName, Currency, InvoicePDFBlobName, Notes, ReceivedAt },
    );
    if (!update) {
      return { status: 400, jsonBody: { error: "No fields to update" } };
    }
    await executeQuery(
      connection,
      `UPDATE JobInvoices SET ${update.setClause} WHERE JobInvoiceID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: JobInvoiceID }, ...update.params],
    );
    const stored = await executeQuery(
      connection,
      `SELECT ${JOB_INVOICE_COLUMNS} FROM JobInvoices WHERE JobInvoiceID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: JobInvoiceID }],
    );
    if (stored.length === 0) return { status: 404, jsonBody: { error: "Invoice not found" } };
    return { status: 200, jsonBody: { invoice: stored[0] } };
  } catch (error: any) {
    context.error("upsertJobInvoice failed:", error.message);
    return errorResponse("Upsert invoice failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/approveJobInvoice ───────────────────────────────────────────────
// Body: { JobInvoiceID, ApprovedBy? }

async function approveJobInvoice(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const { JobInvoiceID, ApprovedBy } = body ?? {};
    if (typeof JobInvoiceID !== "number") {
      return { status: 400, jsonBody: { error: "JobInvoiceID (number) required" } };
    }

    connection = await createConnection(token);
    const rows = await executeQuery(
      connection,
      "SELECT JobID, InvoiceNumber FROM JobInvoices WHERE JobInvoiceID = @Id",
      [{ name: "Id", type: TYPES.Int, value: JobInvoiceID }],
    );
    if (rows.length === 0) return { status: 404, jsonBody: { error: "Invoice not found" } };

    const jobId = rows[0].JobID as number;
    const invoiceNumber = (rows[0].InvoiceNumber as string | null) ?? `#${JobInvoiceID}`;

    await executeQuery(
      connection,
      `UPDATE JobInvoices
       SET Status = 'approved', ApprovedAt = SYSUTCDATETIME(), ApprovedBy = @ApprovedBy
       WHERE JobInvoiceID = @Id`,
      [
        { name: "Id", type: TYPES.Int, value: JobInvoiceID },
        { name: "ApprovedBy", type: TYPES.NVarChar, value: ApprovedBy ?? null },
      ],
    );
    await executeQuery(
      connection,
      `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, InvoiceID)
       VALUES (@JobID, @CreatedBy, @Text, 'invoice_approved', @InvoiceID);`,
      [
        { name: "JobID", type: TYPES.Int, value: jobId },
        { name: "CreatedBy", type: TYPES.NVarChar, value: ApprovedBy ?? null },
        { name: "Text", type: TYPES.NVarChar, value: `Approved invoice ${invoiceNumber}` },
        { name: "InvoiceID", type: TYPES.Int, value: JobInvoiceID },
      ],
    );
    await executeQuery(
      connection,
      "UPDATE Jobs SET LastModifiedDate = SYSUTCDATETIME() WHERE JobID = @JobID",
      [{ name: "JobID", type: TYPES.Int, value: jobId }],
    );

    const stored = await executeQuery(
      connection,
      `SELECT ${JOB_INVOICE_COLUMNS} FROM JobInvoices WHERE JobInvoiceID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: JobInvoiceID }],
    );
    return { status: 200, jsonBody: { invoice: stored[0] } };
  } catch (error: any) {
    context.error("approveJobInvoice failed:", error.message);
    return errorResponse("Approve invoice failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/rejectJobInvoice ────────────────────────────────────────────────
// Body: { JobInvoiceID, RejectedBy? }

async function rejectJobInvoice(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const { JobInvoiceID, RejectedBy } = body ?? {};
    if (typeof JobInvoiceID !== "number") {
      return { status: 400, jsonBody: { error: "JobInvoiceID (number) required" } };
    }

    connection = await createConnection(token);
    const rows = await executeQuery(
      connection,
      "SELECT JobID, InvoiceNumber FROM JobInvoices WHERE JobInvoiceID = @Id",
      [{ name: "Id", type: TYPES.Int, value: JobInvoiceID }],
    );
    if (rows.length === 0) return { status: 404, jsonBody: { error: "Invoice not found" } };

    const jobId = rows[0].JobID as number;
    const invoiceNumber = (rows[0].InvoiceNumber as string | null) ?? `#${JobInvoiceID}`;

    await executeQuery(
      connection,
      "UPDATE JobInvoices SET Status = 'rejected' WHERE JobInvoiceID = @Id",
      [{ name: "Id", type: TYPES.Int, value: JobInvoiceID }],
    );
    await executeQuery(
      connection,
      `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, InvoiceID)
       VALUES (@JobID, @CreatedBy, @Text, 'invoice_rejected', @InvoiceID);`,
      [
        { name: "JobID", type: TYPES.Int, value: jobId },
        { name: "CreatedBy", type: TYPES.NVarChar, value: RejectedBy ?? null },
        { name: "Text", type: TYPES.NVarChar, value: `Rejected invoice ${invoiceNumber}` },
        { name: "InvoiceID", type: TYPES.Int, value: JobInvoiceID },
      ],
    );
    await executeQuery(
      connection,
      "UPDATE Jobs SET LastModifiedDate = SYSUTCDATETIME() WHERE JobID = @JobID",
      [{ name: "JobID", type: TYPES.Int, value: jobId }],
    );

    const stored = await executeQuery(
      connection,
      `SELECT ${JOB_INVOICE_COLUMNS} FROM JobInvoices WHERE JobInvoiceID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: JobInvoiceID }],
    );
    return { status: 200, jsonBody: { invoice: stored[0] } };
  } catch (error: any) {
    context.error("rejectJobInvoice failed:", error.message);
    return errorResponse("Reject invoice failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/deleteJobInvoice ────────────────────────────────────────────────
// Body: { JobInvoiceID }
// Refuses to delete approved invoices.

async function deleteJobInvoice(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const { JobInvoiceID } = body ?? {};
    if (typeof JobInvoiceID !== "number") {
      return { status: 400, jsonBody: { error: "JobInvoiceID (number) required" } };
    }

    connection = await createConnection(token);
    const rows = await executeQuery(
      connection,
      "SELECT Status FROM JobInvoices WHERE JobInvoiceID = @Id",
      [{ name: "Id", type: TYPES.Int, value: JobInvoiceID }],
    );
    if (rows.length === 0) return { status: 404, jsonBody: { error: "Invoice not found" } };
    if (rows[0].Status === "approved") {
      return { status: 400, jsonBody: { error: "Cannot delete an approved invoice. Reject it first." } };
    }

    await executeQuery(
      connection,
      "DELETE FROM JobInvoices WHERE JobInvoiceID = @Id",
      [{ name: "Id", type: TYPES.Int, value: JobInvoiceID }],
    );
    return { status: 200, jsonBody: { deleted: true, invoiceId: JobInvoiceID } };
  } catch (error: any) {
    context.error("deleteJobInvoice failed:", error.message);
    return errorResponse("Delete invoice failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getJobInvoices", { methods: ["GET"], authLevel: "anonymous", handler: getJobInvoices });
app.http("upsertJobInvoice", { methods: ["POST"], authLevel: "anonymous", handler: upsertJobInvoice });
app.http("approveJobInvoice", { methods: ["POST"], authLevel: "anonymous", handler: approveJobInvoice });
app.http("rejectJobInvoice", { methods: ["POST"], authLevel: "anonymous", handler: rejectJobInvoice });
app.http("deleteJobInvoice", { methods: ["POST"], authLevel: "anonymous", handler: deleteJobInvoice });
