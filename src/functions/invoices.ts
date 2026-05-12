import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { buildUpdateSet, createConnection, executeQuery, closeConnection, beginTransaction, commitTransaction, rollbackTransaction, SqlParam } from "../db";
import { fetchInvoices, MyInvoice } from "../mybuildings-client";
import { extractToken, unauthorizedResponse, errorResponse, rolesForRequest } from "../auth";
import { formatDocNumber, nameToAcronym } from "../doc-number";

// ── Approval limit helpers ────────────────────────────────────────────────────

export interface ApprovalLimit {
  RoleName: string;
  /** null means unlimited authority */
  MaxInvoiceAmount: number | null;
}

/**
 * Pure function — determines whether a user with the given roles can approve an
 * invoice of the given amount, given a set of per-role limits.
 *
 * Rules:
 * - A user's effective limit is the maximum of all their matching role limits.
 * - A null limit for any matching role means unlimited authority (always true).
 * - If no matching role is found, approval is denied.
 */
export function canApproveAmount(
  userRoles: string[],
  limits: ApprovalLimit[],
  amount: number,
): boolean {
  const matching = limits.filter((l) => userRoles.includes(l.RoleName));
  if (matching.length === 0) return false;
  // If any matching role has unlimited authority, allow immediately
  if (matching.some((l) => l.MaxInvoiceAmount === null)) return true;
  const effectiveLimit = Math.max(...matching.map((l) => l.MaxInvoiceAmount as number));
  return amount <= effectiveLimit;
}

/**
 * Pure function — returns true when an invoice is stage-1 approved but still
 * waiting on stage-2 (director) approval. Used by the UI banner today; future
 * "bands" rules (e.g. outgoing invoices skip stage 2, or amount < X skips
 * stage 2) live here so call sites stay one-liners.
 */
export function requiresDirectorApproval(invoice: { status: string }): boolean {
  return invoice.status === "approved";
}

// ── Body interfaces ───────────────────────────────────────────────────────────

interface SyncInvoicesBody { queryParams: string }
interface UpsertJobInvoiceBody {
  JobInvoiceID?: number;
  JobID?: number;
  ContractorName?: string;
  Amount?: number;
  Currency?: string;
  /** Per m043 — 'incoming' (contractor → us) or 'outgoing' (us → tenant
   *  for an on-charge recoup). Defaults to 'incoming' for back-compat. */
  Direction?: "incoming" | "outgoing";
  Notes?: string;
  InvoicePDFBlobName?: string;
  SourceEmailID?: number;
  ReceivedAt?: string;
  CreatedBy?: string;
}
interface ApproveJobInvoiceBody { JobInvoiceID: number; ApprovedBy?: string }
interface DirectorApproveJobInvoiceBody { JobInvoiceID: number; ApprovedBy?: string }
interface UndoDirectorApproveJobInvoiceBody { JobInvoiceID: number }
interface RejectJobInvoiceBody { JobInvoiceID: number; RejectedBy?: string }
interface DeleteJobInvoiceBody { JobInvoiceID: number }
interface MarkJobInvoiceMyobCreatedBody { JobInvoiceID: number; CreatedBy?: string }
interface UnmarkJobInvoiceMyobCreatedBody { JobInvoiceID: number }

// POST /api/syncInvoices - fetch from myBuildings and upsert into SQL
async function syncInvoices(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = await request.json() as SyncInvoicesBody;
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
    const params: SqlParam[] = [];

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
  Amount, Currency, Direction, Notes, InvoicePDFBlobName, SourceEmailID, ReceivedAt,
  Status, ApprovedAt, ApprovedBy, DirectorApprovedAt, DirectorApprovedBy,
  MyobCreatedAt, MyobCreatedBy, CreatedAt, CreatedBy
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
    const body = (await request.json()) as UpsertJobInvoiceBody;
    const {
      JobInvoiceID,
      JobID,
      ContractorName,
      Amount,
      Currency,
      Direction,
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
        const invoiceNumber = formatDocNumber({
          prefix: "IV",
          jobId: JobID,
          acronym: nameToAcronym(ContractorName ?? ""),
          seq: nextSeq,
        });

        const direction: "incoming" | "outgoing" =
          Direction === "outgoing" ? "outgoing" : "incoming";
        const inserted = await executeQuery(
          connection,
          `INSERT INTO JobInvoices
             (JobID, InvoiceNumber, Seq, ContractorName, Amount, Currency, Direction,
              Notes, InvoicePDFBlobName, SourceEmailID, ReceivedAt, CreatedBy)
           OUTPUT INSERTED.JobInvoiceID
           VALUES
             (@JobID, @InvoiceNumber, @Seq, @ContractorName, @Amount, @Currency, @Direction,
              @Notes, @InvoicePDFBlobName, @SourceEmailID, @ReceivedAt, @CreatedBy);`,
          [
            { name: "JobID", type: TYPES.Int, value: JobID },
            { name: "InvoiceNumber", type: TYPES.NVarChar, value: invoiceNumber },
            { name: "Seq", type: TYPES.Int, value: nextSeq },
            { name: "ContractorName", type: TYPES.NVarChar, value: ContractorName ?? null },
            { name: "Amount", type: TYPES.Decimal, value: Amount ?? null },
            { name: "Currency", type: TYPES.NVarChar, value: Currency ?? "AUD" },
            { name: "Direction", type: TYPES.NVarChar, value: direction },
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
        Direction: TYPES.NVarChar,
        InvoicePDFBlobName: TYPES.NVarChar,
        Notes: TYPES.NVarChar,
        ReceivedAt: TYPES.DateTime2,
      },
      { Amount, ContractorName, Currency, Direction, InvoicePDFBlobName, Notes, ReceivedAt },
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
// Checks approval limits against the caller's roles before approving.
// On success, transitions the job to status='Done', awaitingRole='accounts'.

async function approveJobInvoice(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as ApproveJobInvoiceBody;
    const { JobInvoiceID, ApprovedBy } = body ?? {};
    if (typeof JobInvoiceID !== "number") {
      return { status: 400, jsonBody: { error: "JobInvoiceID (number) required" } };
    }

    connection = await createConnection(token);

    // Fetch invoice — need Amount for limit check, Direction to decide whether
    // to roll the job to Done (only incoming/contractor invoices do that).
    const rows = await executeQuery(
      connection,
      "SELECT JobID, InvoiceNumber, Amount, Direction FROM JobInvoices WHERE JobInvoiceID = @Id",
      [{ name: "Id", type: TYPES.Int, value: JobInvoiceID }],
    );
    if (rows.length === 0) return { status: 404, jsonBody: { error: "Invoice not found" } };

    const jobId = rows[0].JobID as number;
    const invoiceNumber = (rows[0].InvoiceNumber as string | null) ?? `#${JobInvoiceID}`;
    const amount = (rows[0].Amount as number | null) ?? 0;
    const direction = ((rows[0].Direction as string | null) ?? "incoming") as "incoming" | "outgoing";

    // Approval limit check — resolve caller's roles from X-App-Token
    const userRoles = rolesForRequest(request);
    const escapedRoles = userRoles.map((r) => `'${r.replace(/'/g, "''")}'`).join(", ");
    const limitRows: ApprovalLimit[] = escapedRoles
      ? (await executeQuery(
          connection,
          `SELECT RoleName, MaxInvoiceAmount FROM ApprovalLimits WHERE RoleName IN (${escapedRoles})`,
        ) as ApprovalLimit[])
      : [];

    if (!canApproveAmount(userRoles, limitRows, amount)) {
      const matching = limitRows.filter((l) => userRoles.includes(l.RoleName));
      const effectiveLimit =
        matching.length === 0
          ? 0
          : matching.some((l) => l.MaxInvoiceAmount === null)
            ? null
            : Math.max(...matching.map((l) => l.MaxInvoiceAmount as number));

      return {
        status: 403,
        jsonBody: {
          error: "Insufficient approval authority",
          requiredAmount: amount,
          userLimit: effectiveLimit,
          message:
            "This invoice requires approval from a user with a higher approval limit.",
        },
      };
    }

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

    // Auto-transition job → Done only fires for incoming (contractor)
    // approvals. Outgoing oncharge invoices are sent to tenants and don't
    // imply the job is finished — they only mark the on-charge as approved.
    if (direction === "incoming") {
      await executeQuery(
        connection,
        `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, NewStatus, NewAwaitingRole)
         VALUES (@JobID, @CreatedBy, @Text, 'status_changed', 'Done', 'accounts');`,
        [
          { name: "JobID", type: TYPES.Int, value: jobId },
          { name: "CreatedBy", type: TYPES.NVarChar, value: ApprovedBy ?? null },
          { name: "Text", type: TYPES.NVarChar, value: "Invoice approved — job complete" },
        ],
      );
      await executeQuery(
        connection,
        `UPDATE Jobs SET Status = 'Done', AwaitingRole = 'accounts', LastModifiedDate = SYSUTCDATETIME()
         WHERE JobID = @JobID`,
        [{ name: "JobID", type: TYPES.Int, value: jobId }],
      );
    } else {
      await executeQuery(
        connection,
        "UPDATE Jobs SET LastModifiedDate = SYSUTCDATETIME() WHERE JobID = @JobID",
        [{ name: "JobID", type: TYPES.Int, value: jobId }],
      );
    }

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

// ── POST /api/directorApproveJobInvoice ──────────────────────────────────────
// Body: { JobInvoiceID, ApprovedBy }
// Stage-2 (Director) approval. Caller MUST hold the 'director' role — Admin
// does not double for this on purpose (separation of duties). The invoice must
// be at Status='approved'; this flips it to 'director_approved' and stamps the
// audit columns.

async function directorApproveJobInvoice(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const userRoles = rolesForRequest(request);
  if (!userRoles.includes("director")) {
    return { status: 403, jsonBody: { error: "Director role required" } };
  }

  let connection;
  try {
    const body = (await request.json()) as DirectorApproveJobInvoiceBody;
    const { JobInvoiceID, ApprovedBy } = body ?? {};
    if (typeof JobInvoiceID !== "number") {
      return { status: 400, jsonBody: { error: "JobInvoiceID (number) required" } };
    }

    connection = await createConnection(token);

    const rows = await executeQuery(
      connection,
      `SELECT JobID, InvoiceNumber, Status FROM JobInvoices WHERE JobInvoiceID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: JobInvoiceID }],
    );
    if (rows.length === 0) return { status: 404, jsonBody: { error: "Invoice not found" } };

    const jobId = rows[0].JobID as number;
    const invoiceNumber = (rows[0].InvoiceNumber as string | null) ?? `#${JobInvoiceID}`;
    const status = (rows[0].Status as string) ?? "pending";

    if (status === "director_approved") {
      return { status: 400, jsonBody: { error: "Invoice is already director-approved" } };
    }
    if (status !== "approved") {
      return {
        status: 400,
        jsonBody: { error: "Invoice must be stage-1 approved before director approval" },
      };
    }

    await executeQuery(
      connection,
      `UPDATE JobInvoices
         SET Status = 'director_approved',
             DirectorApprovedAt = SYSUTCDATETIME(),
             DirectorApprovedBy = @ApprovedBy
       WHERE JobInvoiceID = @Id`,
      [
        { name: "Id", type: TYPES.Int, value: JobInvoiceID },
        { name: "ApprovedBy", type: TYPES.NVarChar, value: ApprovedBy ?? null },
      ],
    );
    await executeQuery(
      connection,
      `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, InvoiceID)
       VALUES (@JobID, @CreatedBy, @Text, 'invoice_director_approved', @InvoiceID);`,
      [
        { name: "JobID", type: TYPES.Int, value: jobId },
        { name: "CreatedBy", type: TYPES.NVarChar, value: ApprovedBy ?? null },
        { name: "Text", type: TYPES.NVarChar, value: `Director-approved invoice ${invoiceNumber}` },
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
    context.error("directorApproveJobInvoice failed:", error.message);
    return errorResponse("Director approve invoice failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/undoDirectorApproveJobInvoice ──────────────────────────────────
// Body: { JobInvoiceID }
// Reverses stage 2: Status flips from 'director_approved' back to 'approved'
// and the audit columns clear. Refuses if the invoice has been marked as
// created in MYOB. Caller MUST hold the 'director' role.

async function undoDirectorApproveJobInvoice(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const userRoles = rolesForRequest(request);
  if (!userRoles.includes("director")) {
    return { status: 403, jsonBody: { error: "Director role required" } };
  }

  let connection;
  try {
    const body = (await request.json()) as UndoDirectorApproveJobInvoiceBody;
    const { JobInvoiceID } = body ?? {};
    if (typeof JobInvoiceID !== "number") {
      return { status: 400, jsonBody: { error: "JobInvoiceID (number) required" } };
    }

    connection = await createConnection(token);

    const rows = await executeQuery(
      connection,
      `SELECT JobID, InvoiceNumber, Status, MyobCreatedAt
         FROM JobInvoices WHERE JobInvoiceID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: JobInvoiceID }],
    );
    if (rows.length === 0) return { status: 404, jsonBody: { error: "Invoice not found" } };

    const jobId = rows[0].JobID as number;
    const invoiceNumber = (rows[0].InvoiceNumber as string | null) ?? `#${JobInvoiceID}`;
    const status = (rows[0].Status as string) ?? "pending";
    const myobCreatedAt = rows[0].MyobCreatedAt as Date | null;

    if (status !== "director_approved") {
      return {
        status: 400,
        jsonBody: { error: "Invoice is not director-approved" },
      };
    }
    if (myobCreatedAt != null) {
      return {
        status: 400,
        jsonBody: { error: "Invoice has been created in MYOB — unmark MYOB first" },
      };
    }

    await executeQuery(
      connection,
      `UPDATE JobInvoices
         SET Status = 'approved',
             DirectorApprovedAt = NULL,
             DirectorApprovedBy = NULL
       WHERE JobInvoiceID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: JobInvoiceID }],
    );
    await executeQuery(
      connection,
      `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, InvoiceID)
       VALUES (@JobID, NULL, @Text, 'invoice_director_unapproved', @InvoiceID);`,
      [
        { name: "JobID", type: TYPES.Int, value: jobId },
        { name: "Text", type: TYPES.NVarChar, value: `Director-unapproved invoice ${invoiceNumber}` },
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
    context.error("undoDirectorApproveJobInvoice failed:", error.message);
    return errorResponse("Undo director approve invoice failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── GET /api/getApprovalLimits ────────────────────────────────────────────────
// Returns all rows from the ApprovalLimits table.
// Used by the frontend to display per-role approval authority to users.

async function getApprovalLimits(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    connection = await createConnection(token);
    const rows = await executeQuery(
      connection,
      "SELECT RoleName, MaxInvoiceAmount FROM ApprovalLimits ORDER BY RoleName ASC",
    ) as { RoleName: string; MaxInvoiceAmount: number | null }[];
    const approvalLimits = rows.map((r) => ({
      roleName: r.RoleName,
      maxInvoiceAmount: r.MaxInvoiceAmount,
    }));
    return { status: 200, jsonBody: { approvalLimits } };
  } catch (error: any) {
    context.error("getApprovalLimits failed:", error.message);
    return errorResponse("Failed to fetch approval limits", error.message);
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
    const body = (await request.json()) as RejectJobInvoiceBody;
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

// ── POST /api/markJobInvoiceMyobCreated ──────────────────────────────────────
// Body: { JobInvoiceID, CreatedBy? }
// Records that this invoice has been entered into MYOB. Currently only used
// by outgoing (oncharge) invoices via the InvoicesStep — incoming contractor
// invoices may opt in later when the direct integration lands.

async function markJobInvoiceMyobCreated(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as MarkJobInvoiceMyobCreatedBody;
    const { JobInvoiceID, CreatedBy } = body ?? {};
    if (typeof JobInvoiceID !== "number") {
      return { status: 400, jsonBody: { error: "JobInvoiceID (number) required" } };
    }

    connection = await createConnection(token);

    const rows = await executeQuery(
      connection,
      "SELECT JobID, InvoiceNumber, Status FROM JobInvoices WHERE JobInvoiceID = @Id",
      [{ name: "Id", type: TYPES.Int, value: JobInvoiceID }],
    );
    if (rows.length === 0) return { status: 404, jsonBody: { error: "Invoice not found" } };

    const jobId = rows[0].JobID as number;
    const invoiceNumber = (rows[0].InvoiceNumber as string | null) ?? `#${JobInvoiceID}`;
    const status = (rows[0].Status as string) ?? "pending";

    if (status !== "director_approved") {
      return {
        status: 400,
        jsonBody: { error: "Invoice must be director-approved before MYOB creation" },
      };
    }

    await executeQuery(
      connection,
      `UPDATE JobInvoices
         SET MyobCreatedAt = SYSUTCDATETIME(), MyobCreatedBy = @CreatedBy
       WHERE JobInvoiceID = @Id`,
      [
        { name: "Id", type: TYPES.Int, value: JobInvoiceID },
        { name: "CreatedBy", type: TYPES.NVarChar, value: CreatedBy ?? null },
      ],
    );
    await executeQuery(
      connection,
      `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, InvoiceID)
       VALUES (@JobID, @CreatedBy, @Text, 'invoice_myob_created', @InvoiceID);`,
      [
        { name: "JobID", type: TYPES.Int, value: jobId },
        { name: "CreatedBy", type: TYPES.NVarChar, value: CreatedBy ?? null },
        { name: "Text", type: TYPES.NVarChar, value: `Marked invoice ${invoiceNumber} as created in MYOB` },
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
    context.error("markJobInvoiceMyobCreated failed:", error.message);
    return errorResponse("Mark invoice MYOB created failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/unmarkJobInvoiceMyobCreated ────────────────────────────────────
// Body: { JobInvoiceID }
// Clears the MyobCreatedAt/By fields. No completion gate — invoices don't
// have a downstream "completed" state distinct from approval.

async function unmarkJobInvoiceMyobCreated(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as UnmarkJobInvoiceMyobCreatedBody;
    const { JobInvoiceID } = body ?? {};
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
         SET MyobCreatedAt = NULL, MyobCreatedBy = NULL
       WHERE JobInvoiceID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: JobInvoiceID }],
    );
    await executeQuery(
      connection,
      `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, InvoiceID)
       VALUES (@JobID, NULL, @Text, 'invoice_myob_uncreated', @InvoiceID);`,
      [
        { name: "JobID", type: TYPES.Int, value: jobId },
        { name: "Text", type: TYPES.NVarChar, value: `Unmarked invoice ${invoiceNumber} from MYOB created` },
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
    context.error("unmarkJobInvoiceMyobCreated failed:", error.message);
    return errorResponse("Unmark invoice MYOB created failed", error.message);
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
    const body = (await request.json()) as DeleteJobInvoiceBody;
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
app.http("directorApproveJobInvoice", { methods: ["POST"], authLevel: "anonymous", handler: directorApproveJobInvoice });
app.http("undoDirectorApproveJobInvoice", { methods: ["POST"], authLevel: "anonymous", handler: undoDirectorApproveJobInvoice });
app.http("rejectJobInvoice", { methods: ["POST"], authLevel: "anonymous", handler: rejectJobInvoice });
app.http("deleteJobInvoice", { methods: ["POST"], authLevel: "anonymous", handler: deleteJobInvoice });
app.http("markJobInvoiceMyobCreated", { methods: ["POST"], authLevel: "anonymous", handler: markJobInvoiceMyobCreated });
app.http("unmarkJobInvoiceMyobCreated", { methods: ["POST"], authLevel: "anonymous", handler: unmarkJobInvoiceMyobCreated });
app.http("getApprovalLimits", { methods: ["GET"], authLevel: "anonymous", handler: getApprovalLimits });
