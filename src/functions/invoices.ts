import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES, type Connection } from "tedious";
import { buildUpdateSet, createRequestConnection, executeQuery, closeConnection, beginTransaction, commitTransaction, rollbackTransaction, SqlParam } from "../db";
import { getCachedApprovalLimits } from "../approval-limits-db";
import { SUBJECT_ELIGIBLE_ROLES, decideAuthority, toRoleLimits } from "../approvalAuthority";
import { loadApprovalFacts, loadVarianceFacts, parseDirectorThreshold, resolveApprovalAuthority } from "../approvalAuthority-db";
import { approvalOutcome, type ApprovalRefusalReason } from "../approvalOutcome";
import { isTestJob } from "../testRecords";
import {
  adminRefusal,
  amountRefusal,
  approvableRefusal,
  creatorRefusal,
  holdsAdmin,
  jobMoneyRefusal,
  type MoneyRefusal,
  refusalResponse,
} from "../moneyRules";
import { loadJobForMoney, refuseMoneyChange } from "../moneyJob-db";
import { DEFAULT_VARIANCE_FACTS } from "../moneyRules";
import { checkVariance, readVarianceBody, recordVariance, type RecordedVariance, type VarianceBody } from "../moneyVariance-db";
import { raiseAttributionNotice } from "../approvalAttributionNotice";
import { attributedApprovalEnabled } from "../attributedApproval";
import { fetchInvoices, MyInvoice } from "../mybuildings-client";
import { AppRole, extractToken, requireRole, unauthorizedResponse, errorResponse, rolesForRequest, verifiedIdentityFromRequest } from "../auth";
import { ACTION_ROLES } from "../action-roles";
import { requireMoneyContext } from "../moneyGate";
import { formatDocNumber, nameToAcronym } from "../doc-number";
import { resolveActivePlannerTasks } from "../planner";
import { syncJobActionTriggersStandalone } from "../jobPlannerSync";
import { MAX_LIST_ROWS, paginationSqlSuffix, parsePagination } from "../pagination";
import { decideApprovalAmountEdit } from "../edit-effects";
import { isJobAttachmentBlob, PDF_NOT_A_JOB_ATTACHMENT } from "../job-attachment-blob";
import { parseSupplierInvoiceNumber } from "../supplier-invoice-number";
import { resolveInvoiceContractor } from "../invoice-contractor";
import { newCorrelationId, record } from "../ledger";
import { resolveLedgerActor } from "../ledger/actor";
import {
  amountChange,
  amountUnchanged,
  approvalRule,
  approvalSnapshot,
  approvedAmount,
  contractorFacts,
  deletionAfter,
  invoiceFacts,
  invoiceSnapshot,
  jobScope,
  withContractorId,
} from "../ledger/moneyDecisions";
import { sendDirectorRequest } from "../email/director-requests";
import { recordRefusal, recordRefusalForRequest, recordRoleRefusal, type RefusalTarget } from "../ledger/refusals";
import type { LedgerActor } from "../ledger/types";
import { parseMoneyField } from "../money";

// Approval limits and the director gate live in the approval-authority core
// (src/approvalAuthority.ts, J1); ApprovalLimit rows in approval-limits-db.ts.
export type { ApprovalLimit } from "../approval-limits-db";

/** Payments recorded against an invoice, read inside the caller's transaction. */
async function paymentCount(connection: Connection, invoiceId: number): Promise<number> {
  const rows = await executeQuery(
    connection,
    "SELECT COUNT(*) AS Payments FROM Payments WHERE JobInvoiceID = @Id",
    [{ name: "Id", type: TYPES.Int, value: invoiceId }],
  );
  return Number(rows[0]?.Payments ?? 0);
}

// ── Body interfaces ───────────────────────────────────────────────────────────

interface SyncInvoicesBody { queryParams: string }
interface UpsertJobInvoiceBody {
  JobInvoiceID?: number;
  JobID?: number;
  /** The contractor by id (migration 112), when the request has it: from the
   *  picker, or from the quote or order the invoice answers. Never worked out
   *  from the name. */
  ContractorID?: number | null;
  ContractorName?: string;
  /** A number or a typed string such as "1,500.00"; parsed by parseMoneyField. */
  Amount?: number | string | null;
  Currency?: string;
  /** Per m043 — 'incoming' (contractor → us) or 'outgoing' (us → tenant
   *  for an on-charge recoup). Defaults to 'incoming' for back-compat. */
  Direction?: "incoming" | "outgoing";
  Notes?: string;
  InvoicePDFBlobName?: string;
  SourceEmailID?: number;
  ReceivedAt?: string;
  /** @deprecated ignored — identity comes from the token */
  CreatedBy?: string;
  /** The supplier's own invoice number, verbatim (trimmed), at most 255 characters. */
  SupplierInvoiceNumber?: string | null;
}
interface ApproveJobInvoiceBody {
  JobInvoiceID: number;
  /** R13: an incoming invoice above the approved quote, within the margin: { attributedToUserId, rationale, directorOverrideReason? }. */
  variance?: unknown;
  /** @deprecated ignored — identity comes from the token */
  ApprovedBy?: string;
}
interface DirectorApproveJobInvoiceBody {
  JobInvoiceID: number;
  /** @deprecated ignored — identity comes from the token */
  ApprovedBy?: string;
}
interface UndoDirectorApproveJobInvoiceBody { JobInvoiceID: number }
interface RejectJobInvoiceBody {
  JobInvoiceID: number;
  /** @deprecated ignored — identity comes from the token */
  RejectedBy?: string;
}
interface DeleteJobInvoiceBody { JobInvoiceID: number }
interface MarkJobInvoiceMyobCreatedBody {
  JobInvoiceID: number;
  /** @deprecated ignored — identity comes from the token */
  CreatedBy?: string;
}
interface UnmarkJobInvoiceMyobCreatedBody { JobInvoiceID: number }

// POST /api/syncInvoices - fetch from myBuildings and upsert into SQL
async function syncInvoices(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.ACCOUNTS_APPROVAL]);
  if (denied) return denied;

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

    connection = await createRequestConnection(token);
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

  const denied = await requireRole(request, ACTION_ROLES.viewInvoices.gate);
  if (denied) return denied;

  let connection;
  try {
    connection = await createRequestConnection(token);

    const buildingId = request.query.get("buildingId");
    const statusId = request.query.get("statusId");
    const jobCode = request.query.get("jobCode");

    const pagination = parsePagination(request.query);
    const topClause = pagination.active ? "" : `TOP ${MAX_LIST_ROWS} `;

    let whereSql = "1=1";
    const params: SqlParam[] = [];

    if (buildingId) {
      whereSql += " AND BuildingID = @BuildingID";
      params.push({ name: "BuildingID", type: TYPES.Int, value: parseInt(buildingId) });
    }
    if (statusId) {
      whereSql += " AND StatusID = @StatusID";
      params.push({ name: "StatusID", type: TYPES.Int, value: parseInt(statusId) });
    }
    if (jobCode) {
      whereSql += " AND JobCode = @JobCode";
      params.push({ name: "JobCode", type: TYPES.NVarChar, value: jobCode });
    }

    const sql = `SELECT ${topClause}
      Id, InvoiceID, InvoiceNumber, WorkRequestID, JobCode,
      BuildingName, BuildingID, ContractorName, ContractorID,
      InvoiceAmount, GSTAmount, TotalAmount, InvoiceDate, DateApproved,
      StatusID, Status, InvoicePDFURL, GLAccountCode,
      CreatedAt, UpdatedAt
    FROM Invoices WHERE ${whereSql}
    ORDER BY InvoiceDate DESC${paginationSqlSuffix(pagination)}`;
    const rows = await executeQuery(connection, sql, params);

    let total = rows.length;
    if (pagination.active) {
      const totalRows = await executeQuery(
        connection,
        `SELECT COUNT(*) AS Total FROM Invoices WHERE ${whereSql}`,
        params,
      );
      total = (totalRows[0]?.Total as number) ?? rows.length;
    }

    const truncated = !pagination.active && rows.length >= MAX_LIST_ROWS;
    if (truncated) {
      context.warn(`getInvoices: hit MAX_LIST_ROWS ceiling (${MAX_LIST_ROWS}) — caller should paginate`);
    }

    return {
      status: 200,
      jsonBody: {
        invoices: rows,
        count: rows.length,
        total,
        truncated,
        ...(pagination.active
          ? { page: pagination.page, pageSize: pagination.pageSize }
          : {}),
      },
    };
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
  JobInvoiceID, JobID, InvoiceNumber, SupplierInvoiceNumber, Seq, ContractorName, ContractorID,
  Amount, Currency, Direction, Notes, InvoicePDFBlobName, SourceEmailID, ReceivedAt,
  Status, ApprovedAt, ApprovedBy, DirectorApprovedAt, DirectorApprovedBy,
  DirectorEmailSentAt, DirectorEmailSentTo, DirectorEmailSentBy,
  MyobCreatedAt, MyobCreatedBy, CreatedAt, CreatedBy
`;

// ── GET /api/getJobInvoices?jobId=N ──────────────────────────────────────────

async function getJobInvoices(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, ACTION_ROLES.viewInvoices.gate);
  if (denied) return denied;

  const jobId = request.query.get("jobId");
  if (!jobId) return { status: 400, jsonBody: { error: "jobId query param required" } };

  let connection;
  try {
    connection = await createRequestConnection(token);
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
// Body: { JobInvoiceID?, JobID (required on create), ContractorID?, ContractorName?, Amount?,
//         Currency?, Notes?, InvoicePDFBlobName?, SourceEmailID?, ReceivedAt?, CreatedBy?,
//         SupplierInvoiceNumber? }
//
// ContractorID (migration 112) is stored when the request gives it: from the
// picker, or from the quote or order the invoice answers. Without a name it
// takes the contractor's own. A name on its own is stored as text and never
// matched to a contractor; on an edit it clears the id the invoice had, which
// would otherwise point at the wrong one.

export async function upsertJobInvoice(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  // Plain accounts staff add and edit invoices day-to-day — the approval
  // gate (a separate endpoint) is what actually pushes spend forward, so
  // restricting create/edit to manager-only forced extra hand-offs without
  // changing the control surface. Facilities managers also need to attach
  // invoices that land in their inbox before accounts has seen them.
  const denied = await requireRole(request, ACTION_ROLES.createInvoice.gate);
  if (denied) return denied;

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as UpsertJobInvoiceBody;
    const {
      JobInvoiceID,
      JobID,
      ContractorID,
      ContractorName,
      Amount,
      Currency,
      Direction,
      Notes,
      InvoicePDFBlobName,
      SourceEmailID,
      ReceivedAt,
      SupplierInvoiceNumber,
    } = body ?? {};

    const supplierNumber = parseSupplierInvoiceNumber(SupplierInvoiceNumber);
    if (!supplierNumber.ok) return { status: 400, jsonBody: { error: supplierNumber.error } };
    const amount = parseMoneyField(Amount, "Amount");
    if (!amount.ok) return { status: 400, jsonBody: { error: amount.error } };

    connection = await createRequestConnection(token);

    // The contractor by id, when the request names one; otherwise just the name.
    const contractor = await resolveInvoiceContractor(connection, { ContractorID, ContractorName });
    if (!contractor.ok) return { status: 400, jsonBody: { error: contractor.error } };

    if (JobInvoiceID === undefined) {
      if (typeof JobID !== "number") {
        return { status: 400, jsonBody: { error: "JobID (number) required to create an invoice" } };
      }
      const badAmount = amountRefusal(amount.value, "Amount", true);
      if (badAmount) return refusalResponse(badAmount);
      if (InvoicePDFBlobName != null && !(await isJobAttachmentBlob(connection, JobID, InvoicePDFBlobName))) {
        return { status: 400, jsonBody: { error: PDF_NOT_A_JOB_ATTACHMENT } };
      }

      await beginTransaction(connection);
      try {
        // J3: no invoices on internal, done or archived jobs (row locked to
        // commit). Decision 18: an outgoing (on-charge) invoice may be raised
        // after the job is done, and that is recorded below.
        const moneyJob = await loadJobForMoney(connection, JobID);
        if (!moneyJob) {
          await rollbackTransaction(connection).catch(() => {});
          return { status: 404, jsonBody: { error: "Job not found" } };
        }
        const jobRefusal = jobMoneyRefusal(moneyJob, { outgoingInvoice: Direction === "outgoing" });
        if (jobRefusal) {
          return await refuseMoneyChange(connection, request, {
            attempted: "invoice.create",
            jobId: JobID,
            refusal: jobRefusal,
            state: { direction: Direction === "outgoing" ? "outgoing" : "incoming", jobStatus: moneyJob.status },
            subject: { id: JobID, type: "job" },
          });
        }
        const raisedAfterClose = moneyJob.status === "Done" && Direction === "outgoing";
        const raiser = raisedAfterClose ? await resolveLedgerActor(request, connection) : null;
        if (raisedAfterClose && !raiser) {
          await rollbackTransaction(connection).catch(() => {});
          return unauthorizedResponse();
        }
        const seqRows = await executeQuery(
          connection,
          `SELECT ISNULL(MAX(Seq), 0) + 1 AS NextSeq FROM JobInvoices WITH (UPDLOCK, HOLDLOCK) WHERE JobID = @JobID`,
          [{ name: "JobID", type: TYPES.Int, value: JobID }],
        );
        const nextSeq = (seqRows[0]?.NextSeq as number) ?? 1;
        const invoiceNumber = formatDocNumber({
          prefix: "IV",
          jobId: JobID,
          acronym: nameToAcronym(contractor.name ?? ""),
          seq: nextSeq,
        });

        const direction: "incoming" | "outgoing" =
          Direction === "outgoing" ? "outgoing" : "incoming";
        const inserted = await executeQuery(
          connection,
          `INSERT INTO JobInvoices
             (JobID, InvoiceNumber, Seq, ContractorID, ContractorName, Amount, Currency, Direction,
              Notes, InvoicePDFBlobName, SourceEmailID, ReceivedAt, CreatedBy,
              SupplierInvoiceNumber)
           OUTPUT INSERTED.JobInvoiceID
           VALUES
             (@JobID, @InvoiceNumber, @Seq, @ContractorID, @ContractorName, @Amount, @Currency, @Direction,
              @Notes, @InvoicePDFBlobName, @SourceEmailID, @ReceivedAt, @CreatedBy,
              @SupplierInvoiceNumber);`,
          [
            { name: "JobID", type: TYPES.Int, value: JobID },
            { name: "InvoiceNumber", type: TYPES.NVarChar, value: invoiceNumber },
            { name: "Seq", type: TYPES.Int, value: nextSeq },
            { name: "ContractorID", type: TYPES.Int, value: contractor.id ?? null },
            { name: "ContractorName", type: TYPES.NVarChar, value: contractor.name ?? null },
            { name: "Amount", type: TYPES.Decimal, value: amount.value ?? null },
            { name: "Currency", type: TYPES.NVarChar, value: Currency ?? "AUD" },
            { name: "Direction", type: TYPES.NVarChar, value: direction },
            { name: "Notes", type: TYPES.NVarChar, value: Notes ?? null },
            { name: "InvoicePDFBlobName", type: TYPES.NVarChar, value: InvoicePDFBlobName ?? null },
            { name: "SourceEmailID", type: TYPES.Int, value: SourceEmailID ?? null },
            { name: "ReceivedAt", type: TYPES.DateTime2, value: ReceivedAt ?? null },
            { name: "CreatedBy", type: TYPES.NVarChar, value: identity.name },
            { name: "SupplierInvoiceNumber", type: TYPES.NVarChar, value: supplierNumber.value ?? null },
          ],
        );
        const newId = inserted[0].JobInvoiceID as number;

        const amountLabel = typeof amount.value === "number" ? ` · $${amount.value.toLocaleString()}` : "";
        const contractorLabel = contractor.name ? ` · ${contractor.name}` : "";
        await executeQuery(
          connection,
          `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, InvoiceID)
           VALUES (@JobID, @CreatedBy, @Text, 'invoice_added', @InvoiceID);`,
          [
            { name: "JobID", type: TYPES.Int, value: JobID },
            { name: "CreatedBy", type: TYPES.NVarChar, value: identity.name },
            { name: "Text", type: TYPES.NVarChar, value: `Added invoice ${invoiceNumber}${contractorLabel}${amountLabel}` },
            { name: "InvoiceID", type: TYPES.Int, value: newId },
          ],
        );
        if (raiser) {
          await record(connection, {
            action: "invoice.raised_after_close",
            actor: raiser,
            after: {
              ...invoiceFacts(
                await withContractorId(connection, {
                  Amount: amount.value,
                  ContractorID: contractor.id ?? null,
                  ContractorName: contractor.name ?? null,
                  Direction: "outgoing",
                  InvoiceNumber: invoiceNumber,
                  SupplierInvoiceNumber: supplierNumber.value ?? null,
                }),
              ),
              jobStatus: "Done",
            },
            buildingId: moneyJob.buildingId,
            jobId: JobID,
            ruleApplied: "outgoing_after_close",
            subject: { id: newId, type: "invoice" },
          });
        }
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

        // Outgoing invoice raised → accounts' oncharge work is done. Eager
        // resolve the Planner task; the nightly sweep is the safety net.
        if (direction === "outgoing") {
          await syncJobActionTriggersStandalone(JobID, (msg) => context.log(msg));
        }

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
        ContractorID: TYPES.Int,
        ContractorName: TYPES.NVarChar,
        Currency: TYPES.NVarChar,
        Direction: TYPES.NVarChar,
        InvoicePDFBlobName: TYPES.NVarChar,
        Notes: TYPES.NVarChar,
        ReceivedAt: TYPES.DateTime2,
        SupplierInvoiceNumber: TYPES.NVarChar,
      },
      {
        Amount: amount.value,
        ContractorID: contractor.id,
        ContractorName: contractor.name,
        Currency,
        Direction,
        InvoicePDFBlobName,
        Notes,
        ReceivedAt,
        SupplierInvoiceNumber: supplierNumber.value,
      },
    );
    if (!update) {
      return { status: 400, jsonBody: { error: "No fields to update" } };
    }

    const badAmount = amountRefusal(amount.value, "Amount", false);
    if (badAmount) return refusalResponse(badAmount);

    // An edit that carries an amount or a payee can tear down an existing
    // approval, which is a decision (PLAN §3.12): the reset and its ledger row
    // commit together or not at all. Only those edits look up who is editing.
    let actor: LedgerActor | null = null;
    if (Amount !== undefined || ContractorID !== undefined || ContractorName !== undefined) {
      actor = await resolveLedgerActor(request, connection);
      if (!actor) return unauthorizedResponse();
    }

    await beginTransaction(connection);
    try {
      // Read the existing invoice before mutating so we can diff for the audit
      // trail and detect whether the edit invalidates a prior approval. Locked
      // until commit, so the approval recorded as reset is the one reset.
      const beforeRows = await executeQuery(
        connection,
        `SELECT JobInvoiceID, JobID, InvoiceNumber, Amount, ContractorName, Status, ApprovedAt,
                ApprovedBy, DirectorApprovedAt, DirectorApprovedBy, SupplierInvoiceNumber, Direction, Currency,
                MyobCreatedAt, ContractorID
           FROM JobInvoices WITH (UPDLOCK, HOLDLOCK) WHERE JobInvoiceID = @Id`,
        [{ name: "Id", type: TYPES.Int, value: JobInvoiceID }],
      );
      if (beforeRows.length === 0) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: "Invoice not found" } };
      }
      const before = beforeRows[0];
      const jobId = before.JobID as number;
      if (InvoicePDFBlobName != null && !(await isJobAttachmentBlob(connection, jobId, InvoicePDFBlobName))) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 400, jsonBody: { error: PDF_NOT_A_JOB_ATTACHMENT } };
      }
      const invoiceNumber =
        (before.InvoiceNumber as string | null) ?? `#${JobInvoiceID}`;

      // J3: the job still takes money changes. Decision 18: an outgoing
      // (on-charge) invoice that stays outgoing may be worked on after Done.
      const staysOutgoing = before.Direction === "outgoing" && (Direction === undefined || Direction === "outgoing");
      const moneyJob = await loadJobForMoney(connection, jobId);
      const jobRefusal = moneyJob ? jobMoneyRefusal(moneyJob, { outgoingInvoice: staysOutgoing }) : null;
      if (jobRefusal) {
        return await refuseMoneyChange(connection, request, {
          attempted: "invoice.edit",
          jobId,
          refusal: jobRefusal,
          state: { jobStatus: moneyJob?.status ?? null, status: before.Status ?? null },
          subject: { id: JobInvoiceID, type: "invoice" },
        });
      }

      const effects = decideApprovalAmountEdit(
        {
          amount: before.Amount != null ? Number(before.Amount) : null,
          approvedAt: (before.ApprovedAt as Date | null) ?? null,
          contractorId: (before.ContractorID as number | null) ?? null,
          contractorName: (before.ContractorName as string | null) ?? null,
          status: (before.Status as string | null) ?? null,
        },
        { amount: amount.value, contractorId: contractor.id, contractorName: contractor.name },
      );
      // Once money has been paid against the invoice, what it was for and who
      // it pays are facts someone acted on (J3).
      if ((effects.amountChanged || effects.contractorChanged) && (await paymentCount(connection, JobInvoiceID)) > 0) {
        return await refuseMoneyChange(connection, request, {
          attempted: "invoice.edit",
          jobId,
          refusal: {
            code: "invoice_paid",
            message: "Payments are recorded against this invoice, so its amount and contractor can't change.",
            status: 409,
          },
          state: { amount: before.Amount ?? null, status: before.Status ?? null },
          subject: { id: JobInvoiceID, type: "invoice" },
        });
      }

      // A new name with no id says the invoice is from someone else now, so the
      // id it had would point at the wrong contractor.
      const clearsContractorId =
        contractor.id === undefined &&
        ContractorName !== undefined &&
        ContractorName !== before.ContractorName &&
        before.ContractorID != null;
      const setClause = clearsContractorId ? `${update.setClause}, ContractorID = NULL` : update.setClause;

      await executeQuery(
        connection,
        `UPDATE JobInvoices SET ${setClause} WHERE JobInvoiceID = @Id`,
        [{ name: "Id", type: TYPES.Int, value: JobInvoiceID }, ...update.params],
      );

      await executeQuery(
        connection,
        `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, InvoiceID)
         VALUES (@JobID, @CreatedBy, @Text, 'invoice_edited', @InvoiceID);`,
        [
          { name: "JobID", type: TYPES.Int, value: jobId },
          { name: "CreatedBy", type: TYPES.NVarChar, value: identity.name },
          {
            name: "Text",
            type: TYPES.NVarChar,
            value: `Edited invoice ${invoiceNumber}: ${effects.summary}`,
          },
          { name: "InvoiceID", type: TYPES.Int, value: JobInvoiceID },
        ],
      );

      // A changed amount or payee on an approved invoice tears the approval
      // down, and any MYOB mark with it: MYOB holds the old amount or payee
      // (J3). The job stays where it is, just with a pending invoice.
      if (effects.clearApproval) {
        await executeQuery(
          connection,
          `UPDATE JobInvoices
              SET Status = 'pending',
                  ApprovedAt = NULL, ApprovedBy = NULL,
                  DirectorApprovedAt = NULL, DirectorApprovedBy = NULL,
                  DirectorEmailSentAt = NULL, DirectorEmailSentTo = NULL,
                  DirectorEmailSentBy = NULL,
                  MyobCreatedAt = NULL, MyobCreatedBy = NULL
            WHERE JobInvoiceID = @Id`,
          [{ name: "Id", type: TYPES.Int, value: JobInvoiceID }],
        );
        const why = effects.contractorChanged ? "payee_changed" : "amount_changed";
        await executeQuery(
          connection,
          `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, InvoiceID)
           VALUES (@JobID, @CreatedBy, @Text, 'invoice_unapproved', @InvoiceID);`,
          [
            { name: "JobID", type: TYPES.Int, value: jobId },
            { name: "CreatedBy", type: TYPES.NVarChar, value: identity.name },
            {
              name: "Text",
              type: TYPES.NVarChar,
              value: `Invoice ${invoiceNumber} ${effects.contractorChanged ? "contractor" : "amount"} changed — approval${before.MyobCreatedAt != null ? " and MYOB mark" : ""} cleared, awaiting re-review.`,
            },
            { name: "InvoiceID", type: TYPES.Int, value: JobInvoiceID },
          ],
        );

        // Only an edit that carries an amount or a payee can get here, and
        // those looked up who is editing above.
        if (!actor) throw new Error("An approval was reset without a ledger actor");
        const scope = await jobScope(connection, jobId);
        const known = await withContractorId(connection, before);
        // What the invoice's columns hold once this edit is in: the id the request
        // gave, or the one it had if the name is unchanged, or none (and then the
        // ledger looks one up from the new name).
        const editedName = contractor.name !== undefined ? contractor.name : before.ContractorName;
        const editedId =
          contractor.id !== undefined ? contractor.id : editedName !== before.ContractorName ? null : before.ContractorID;
        const edited = await withContractorId(connection, {
          ...before,
          Amount: amount.value !== undefined ? amount.value : before.Amount,
          ContractorID: editedId,
          ContractorName: editedName,
          Direction: Direction !== undefined ? Direction : before.Direction,
          SupplierInvoiceNumber: supplierNumber.value !== undefined ? supplierNumber.value : before.SupplierInvoiceNumber,
        });
        await record(connection, {
          action: "invoice.approval_reset",
          actor,
          after: {
            ...invoiceFacts(edited),
            ...amountChange({ approved: before.Amount, next: edited.Amount, previous: before.Amount }),
            status: "pending",
          },
          before: approvalSnapshot(known),
          buildingId: scope.buildingId,
          jobId: scope.jobId,
          ruleApplied: why,
          subject: { id: JobInvoiceID, type: "invoice" },
        });
      }

      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }

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
// Body: { JobInvoiceID } — the approver is the verified caller, never the body.
// Checks approval limits against the caller's roles before approving.
// Does NOT auto-transition the job — the job stays in its current status so a
// person decides when it's truly done (e.g. after marking it created in MYOB).
//
// The approval is a decision (PLAN §3.12): its writes and its ledger row
// commit together or not at all.

const APPROVE_INVOICE_TARGET: RefusalTarget = {
  attempted: "invoice.approve",
  idField: "JobInvoiceID",
  subjectType: "invoice",
};

interface InvoiceApproval {
  amount: number;
  /** R13: the variance accepted with this approval, for its manager's notice. */
  variance: RecordedVariance | null;
  directorGateEngaged: boolean;
  /** The invoice's ledger facts, for the director request that may follow. */
  facts: Record<string, unknown>;
  jobId: number;
  newStatus: "approved" | "awaiting_approval";
  routesToAwaitingApproval: boolean;
}

type InvoiceApprovalOutcome =
  | { approval: InvoiceApproval; ok: true }
  | { ok: false; response: HttpResponseInit }
  | { jobId: number; ok: false; refusal: InvoiceRefusal };

/** A refused decision on an invoice: what the ledger records and what the caller sees. */
interface InvoiceRefusal {
  action: "denied" | "sod_blocked";
  code: ApprovalRefusalReason | string;
  details?: Record<string, unknown>;
  httpStatus: number;
  message: string;
  status: string | null;
}

function invoiceRefusal(refusal: MoneyRefusal, invoiceStatus: string | null): InvoiceRefusal {
  return {
    action: refusal.code === "creator" ? "sod_blocked" : "denied",
    code: refusal.code,
    details: refusal.details,
    httpStatus: refusal.status,
    message: refusal.message,
    status: invoiceStatus,
  };
}

async function approveInvoiceInTransaction(
  connection: Connection,
  input: {
    actor: LedgerActor;
    approvedBy: string;
    correlationId: string;
    email: string;
    invoiceId: number;
    userRoles: string[];
    variance: VarianceBody | null;
  },
): Promise<InvoiceApprovalOutcome> {
  const { actor, approvedBy, correlationId, email, invoiceId, userRoles } = input;
  await beginTransaction(connection);
  try {
    // Fetch invoice — need Amount for limit check. Locked until commit, so the
    // status recorded as replaced is the one that was replaced.
    const rows = await executeQuery(
      connection,
      "SELECT JobID, InvoiceNumber, Amount, Direction, Status, ContractorName, SupplierInvoiceNumber, ContractorID, CreatedBy FROM JobInvoices WITH (UPDLOCK, HOLDLOCK) WHERE JobInvoiceID = @Id",
      [{ name: "Id", type: TYPES.Int, value: invoiceId }],
    );
    if (rows.length === 0) {
      await rollbackTransaction(connection).catch(() => {});
      return { ok: false, response: { status: 404, jsonBody: { error: "Invoice not found" } } };
    }
    const invoice = rows[0];
    const jobId = invoice.JobID as number;
    const invoiceNumber = (invoice.InvoiceNumber as string | null) ?? `#${invoiceId}`;
    // The director email shows the amount; an unknown one reads as 0.00 there,
    // but is never treated as $0 by the authority check below.
    const amount = (invoice.Amount as number | null) ?? 0;
    const invoiceStatus = (invoice.Status as string | null) ?? null;

    // J3, in order: the job takes money changes (an outgoing invoice after
    // Done included, decision 18); the invoice is still waiting for a decision
    // (a rejected or approved one isn't approved again); and whoever added it
    // doesn't approve it, unless a director (decision 17).
    const moneyJob = await loadJobForMoney(connection, jobId);
    const stateRefusal =
      (moneyJob ? jobMoneyRefusal(moneyJob, { outgoingInvoice: invoice.Direction === "outgoing" }) : null) ??
      approvableRefusal(invoiceStatus, "invoice") ??
      creatorRefusal(invoice.CreatedBy, { name: approvedBy, roles: userRoles }, "invoice");
    if (stateRefusal) {
      await rollbackTransaction(connection).catch(() => {});
      return { jobId, ok: false, refusal: invoiceRefusal(stateRefusal, invoiceStatus) };
    }

    // R13: a contractor's invoice above the job's approved quote is approved
    // only within the margin (cumulative, against the quote; an amount already
    // accepted on the job's POs or invoices counts), with a rationale and a
    // named manager. An invoice with no amount is left to the director, as the
    // authority core sends it there; an on-charge invoice isn't the contractor's.
    const invoiceAmount = invoice.Amount == null ? null : Number(invoice.Amount);
    const variance =
      invoice.Direction !== "outgoing" && invoiceAmount !== null
        ? await checkVariance(connection, {
            accepted: { jobId },
            body: input.variance,
            buildingId: moneyJob?.buildingId ?? null,
            editor: { email, roles: userRoles, userId: actor.kind === "user" ? (actor.userId ?? undefined) : undefined },
            jobId,
            newAmount: invoiceAmount,
            subject: "invoice",
          })
        : null;
    if (variance?.decision.kind === "refused") {
      await rollbackTransaction(connection).catch(() => {});
      return { jobId, ok: false, refusal: invoiceRefusal(variance.decision.refusal, invoiceStatus) };
    }

    // The approval-authority core decides (J1), as for quotes. Past the
    // director threshold (or with no amount) the invoice is approved for stage
    // 1 and the director approves stage 2; past the caller's limit it waits
    // for someone further up the route; any other "no" is refused.
    const scope = await jobScope(connection, jobId);
    const facts = await loadApprovalFacts(connection, scope.buildingId);
    const isTest = userRoles.some((role) => role.trim().toLowerCase() === AppRole.ADMIN) && (await isTestJob(connection, jobId));
    const outcome = approvalOutcome(
      { email, roles: userRoles, userId: actor.kind === "user" ? (actor.userId ?? undefined) : undefined },
      { amount: invoice.Amount == null ? NaN : Number(invoice.Amount), buildingId: scope.buildingId ?? 0, jobId, subject: "invoice" },
      facts,
      { isTest },
    );
    if (outcome.kind === "refused") {
      await rollbackTransaction(connection).catch(() => {});
      return {
        jobId,
        ok: false,
        refusal: { action: "denied", code: outcome.reason, httpStatus: 403, message: outcome.message, status: invoiceStatus },
      };
    }
    const userCanApprove = outcome.kind === "approved";
    const directorGateEngaged = outcome.kind === "awaiting_director";
    const routesToAwaitingApproval = outcome.kind === "awaiting_approval";
    const newStatus = routesToAwaitingApproval ? "awaiting_approval" : "approved";

    await executeQuery(
      connection,
      `UPDATE JobInvoices
       SET Status = @Status, ApprovedAt = SYSUTCDATETIME(), ApprovedBy = @ApprovedBy
       WHERE JobInvoiceID = @Id`,
      [
        { name: "Id", type: TYPES.Int, value: invoiceId },
        { name: "Status", type: TYPES.NVarChar, value: newStatus },
        { name: "ApprovedBy", type: TYPES.NVarChar, value: approvedBy },
      ],
    );
    await executeQuery(
      connection,
      `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, InvoiceID)
       VALUES (@JobID, @CreatedBy, @Text, @EventType, @InvoiceID);`,
      [
        { name: "JobID", type: TYPES.Int, value: jobId },
        { name: "CreatedBy", type: TYPES.NVarChar, value: approvedBy },
        {
          name: "Text",
          type: TYPES.NVarChar,
          value: routesToAwaitingApproval
            ? `Submitted invoice ${invoiceNumber} — awaiting approval`
            : `Approved invoice ${invoiceNumber}`,
        },
        {
          name: "EventType",
          type: TYPES.NVarChar,
          value: routesToAwaitingApproval ? "invoice_awaiting_approval" : "invoice_approved",
        },
        { name: "InvoiceID", type: TYPES.Int, value: invoiceId },
      ],
    );
    // No auto-status-transition on invoice approval — the job stays where it
    // is. Users mark the job Done themselves once they've actually closed it
    // out (typically after the invoice is created in MYOB). Touch
    // LastModifiedDate so the activity feed reflects the approval.
    await executeQuery(
      connection,
      "UPDATE Jobs SET LastModifiedDate = SYSUTCDATETIME() WHERE JobID = @JobID",
      [{ name: "JobID", type: TYPES.Int, value: jobId }],
    );

    const known = await withContractorId(connection, invoice);
    const ledgerFacts = invoiceFacts(known);
    await record(connection, {
      action: "invoice.approve",
      actor,
      after: { status: newStatus, ...ledgerFacts },
      before: { status: (invoice.Status as string | null) ?? null, ...contractorFacts(known) },
      buildingId: scope.buildingId,
      correlationId,
      jobId: scope.jobId,
      ruleApplied: approvalRule({ directorNeeded: directorGateEngaged, userCanApprove }),
      subject: { id: invoiceId, type: "invoice" },
    });

    // Recorded only once the invoice is approved (stage 1 included): routed up
    // to someone senior, it is their approval, and their check, that counts.
    const accepted =
      newStatus === "approved" && variance && (variance.decision.kind === "within_tolerance" || variance.decision.kind === "director_override")
        ? await recordVariance(connection, {
            actor,
            after: ledgerFacts,
            before: contractorFacts(known),
            correlationId,
            decision: variance.decision,
            jobId,
            previousAmount: variance.originalAmount,
            quoteId: variance.quoteId,
            scope,
            subject: { id: invoiceId, type: "invoice" },
          })
        : null;

    await commitTransaction(connection);
    return {
      ok: true,
      approval: { amount, directorGateEngaged, facts: ledgerFacts, jobId, newStatus, routesToAwaitingApproval, variance: accepted },
    };
  } catch (err) {
    await rollbackTransaction(connection).catch(() => {});
    throw err;
  }
}

async function approveJobInvoice(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, ACTION_ROLES.approveInvoice.gate);
  if (denied) {
    await recordRoleRefusal(request, token, denied, APPROVE_INVOICE_TARGET);
    return denied;
  }

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as ApproveJobInvoiceBody;
    const { JobInvoiceID } = body ?? {};
    if (typeof JobInvoiceID !== "number") {
      return { status: 400, jsonBody: { error: "JobInvoiceID (number) required" } };
    }
    const varianceBody = readVarianceBody(body?.variance);
    if (!varianceBody.ok) return { status: 400, jsonBody: { error: varianceBody.error } };

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();

    // The approval and the director request it triggers are one operation.
    const correlationId = newCorrelationId();
    const outcome = await approveInvoiceInTransaction(connection, {
      variance: varianceBody.value,
      actor,
      approvedBy: identity.name,
      correlationId,
      email: identity.email,
      invoiceId: JobInvoiceID,
      userRoles: await rolesForRequest(request),
    });
    if (!outcome.ok) {
      if ("response" in outcome) return outcome.response;
      const { action, code, details, httpStatus, message, status } = outcome.refusal;
      // Ledgered in a transaction of its own now that the decision's has rolled back.
      return await refuseMoneyChange(connection, request, {
        action,
        attempted: "invoice.approve",
        jobId: outcome.jobId,
        refusal: { code, details, message, status: httpStatus as MoneyRefusal["status"] },
        state: { status },
        subject: { id: JobInvoiceID, type: "invoice" },
      });
    }
    const { amount, directorGateEngaged, facts, jobId, newStatus, routesToAwaitingApproval, variance } = outcome.approval;
    if (variance && variance.attributedToUserId !== null) {
      await raiseAttributionNotice(connection, { actor, managerUserId: variance.attributedToUserId, ref: { id: variance.varianceId, jobId, kind: "variance" } });
    }

    // Director email + job→Done transition both gated on a successful approve
    // landing at status='approved'. If we routed to awaiting_approval, nothing
    // else fires until a senior manager re-approves.
    //
    // Fire-and-forget: spawn the email on a FRESH connection so the request
    // connection closes in `finally` once the response returns. Packet build
    // + Graph sendMail can take 5–20s with attachments — we don't want the
    // user's Approve click to block on it. If the background send fails, the
    // Resend button on the banner is the recovery path. The stamp and the
    // ledger row for the send are written once the mail has gone (see
    // ../email/director-requests).
    if (directorGateEngaged && !routesToAwaitingApproval) {
      void (async () => {
        let bgConnection;
        try {
          bgConnection = await createRequestConnection(token);
          await sendDirectorRequest({
            actor,
            amount,
            connection: bgConnection,
            correlationId,
            currency: "AUD",
            facts,
            jobId,
            resend: false,
            stage: "invoice",
            subjectId: JobInvoiceID,
            triggeredBy: identity.name,
          });
        } catch (emailErr: any) {
          context.warn(`Director email failed for invoice ${JobInvoiceID}: ${emailErr?.message}`);
        } finally {
          if (bgConnection) closeConnection(bgConnection);
        }
      })();
    }

    const stored = await executeQuery(
      connection,
      `SELECT ${JOB_INVOICE_COLUMNS} FROM JobInvoices WHERE JobInvoiceID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: JobInvoiceID }],
    );

    // Eager-fire the job-bound Planner triggers. Status='approved' means the
    // director_approval count for this job has just gone up; the combined
    // sync also re-checks oncharge/awaiting/stalled (all idempotent).
    if (newStatus === "approved") {
      await syncJobActionTriggersStandalone(jobId, (msg) => context.log(msg));
    }

    return { status: 200, jsonBody: { invoice: stored[0] } };
  } catch (error: any) {
    context.error("approveJobInvoice failed:", error.message);
    return errorResponse("Approve invoice failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/directorApproveJobInvoice ──────────────────────────────────────
// Body: { JobInvoiceID } — the approver is the verified caller, never the body.
// Stage-2 (Director) approval. Caller MUST hold the 'director' role — Admin
// does not double for this on purpose (separation of duties). The invoice must
// be at Status='approved'; this flips it to 'director_approved' and stamps the
// audit columns. The flip and its ledger row commit together or not at all.

const DIRECTOR_APPROVE_INVOICE_TARGET: RefusalTarget = {
  attempted: "invoice.director_approve",
  idField: "JobInvoiceID",
  subjectType: "invoice",
};

async function directorApproveJobInvoice(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, ACTION_ROLES.approveInvoiceAsDirector.gate);
  if (denied) {
    await recordRoleRefusal(request, token, denied, DIRECTOR_APPROVE_INVOICE_TARGET);
    return denied;
  }

  const userRoles = await rolesForRequest(request);
  if (!userRoles.includes(AppRole.DIRECTOR)) {
    await recordRefusalForRequest(request, token, DIRECTOR_APPROVE_INVOICE_TARGET, {
      code: "director_role_required",
      message: "Director role required",
    });
    return { status: 403, jsonBody: { error: "Director role required" } };
  }
  // Money action (S11): allowed network, fresh sign-in, MFA. src/money-gated-routes.ts
  const gate = await requireMoneyContext(request);
  if (gate) return gate;

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as DirectorApproveJobInvoiceBody;
    const { JobInvoiceID } = body ?? {};
    if (typeof JobInvoiceID !== "number") {
      return { status: 400, jsonBody: { error: "JobInvoiceID (number) required" } };
    }

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();

    let jobId: number;
    await beginTransaction(connection);
    try {
      // Locked until commit, so the status recorded as replaced is the one replaced.
      const rows = await executeQuery(
        connection,
        `SELECT JobID, InvoiceNumber, Status, Amount, Direction, ContractorName, SupplierInvoiceNumber, ContractorID
           FROM JobInvoices WITH (UPDLOCK, HOLDLOCK) WHERE JobInvoiceID = @Id`,
        [{ name: "Id", type: TYPES.Int, value: JobInvoiceID }],
      );
      if (rows.length === 0) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: "Invoice not found" } };
      }
      const invoice = rows[0];

      jobId = invoice.JobID as number;
      const invoiceNumber = (invoice.InvoiceNumber as string | null) ?? `#${JobInvoiceID}`;
      const status = (invoice.Status as string) ?? "pending";

      if (status === "director_approved") {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 400, jsonBody: { error: "Invoice is already director-approved" } };
      }
      if (status !== "approved") {
        // Stage 1 can't be skipped: a refused attempt, ledgered in a
        // transaction of its own now that this one has rolled back.
        await rollbackTransaction(connection).catch(() => {});
        const error = "Invoice must be stage-1 approved before director approval";
        await recordRefusal(
          connection,
          actor,
          { id: JobInvoiceID, type: "invoice" },
          { attempted: "invoice.director_approve", code: "stage_one_approval_required", message: error, state: { status } },
          jobId,
        );
        return { status: 400, jsonBody: { error } };
      }
      // J3: the job still takes money decisions (an outgoing invoice after
      // Done included, decision 18), read under lock.
      const moneyJob = await loadJobForMoney(connection, jobId);
      const jobRefusal = moneyJob ? jobMoneyRefusal(moneyJob, { outgoingInvoice: invoice.Direction === "outgoing" }) : null;
      if (jobRefusal) {
        return await refuseMoneyChange(connection, request, {
          attempted: "invoice.director_approve",
          jobId,
          refusal: jobRefusal,
          state: { jobStatus: moneyJob?.status ?? null, status },
          subject: { id: JobInvoiceID, type: "invoice" },
        });
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
          { name: "ApprovedBy", type: TYPES.NVarChar, value: identity.name },
        ],
      );
      await executeQuery(
        connection,
        `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, InvoiceID)
         VALUES (@JobID, @CreatedBy, @Text, 'invoice_director_approved', @InvoiceID);`,
        [
          { name: "JobID", type: TYPES.Int, value: jobId },
          { name: "CreatedBy", type: TYPES.NVarChar, value: identity.name },
          { name: "Text", type: TYPES.NVarChar, value: `Director-approved invoice ${invoiceNumber}` },
          { name: "InvoiceID", type: TYPES.Int, value: JobInvoiceID },
        ],
      );
      // No auto-status-transition on director approval — the job stays where it
      // is. A person decides when the job is actually done (typically after
      // marking the invoice created in MYOB). Touch LastModifiedDate so the
      // activity feed reflects the approval.
      await executeQuery(
        connection,
        "UPDATE Jobs SET LastModifiedDate = SYSUTCDATETIME() WHERE JobID = @JobID",
        [{ name: "JobID", type: TYPES.Int, value: jobId }],
      );

      const scope = await jobScope(connection, jobId);
      const known = await withContractorId(connection, invoice);
      await record(connection, {
        action: "invoice.director_approve",
        actor,
        after: { status: "director_approved", ...invoiceFacts(known) },
        before: { status, ...contractorFacts(known) },
        buildingId: scope.buildingId,
        jobId: scope.jobId,
        subject: { id: JobInvoiceID, type: "invoice" },
      });
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }

    const stored = await executeQuery(
      connection,
      `SELECT ${JOB_INVOICE_COLUMNS} FROM JobInvoices WHERE JobInvoiceID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: JobInvoiceID }],
    );
    resolveActivePlannerTasks("job", jobId, ["director_approval"]).catch(
      (err: unknown) =>
        context.warn("plannerResolve (directorApproveJobInvoice):", err instanceof Error ? err.message : String(err)),
    );
    return { status: 200, jsonBody: { invoice: stored[0] } };
  } catch (error: any) {
    context.error("directorApproveJobInvoice failed:", error.message);
    return errorResponse("Director approve invoice failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// What the ledger needs to know about an invoice that is about to change or go.
const INVOICE_LEDGER_COLUMNS = `JobID, InvoiceNumber, SupplierInvoiceNumber, ContractorName, ContractorID, Amount, Currency,
  Direction, Status, ApprovedAt, ApprovedBy, DirectorApprovedAt, DirectorApprovedBy,
  MyobCreatedAt, MyobCreatedBy, InvoicePDFBlobName`;

// ── POST /api/undoDirectorApproveJobInvoice ──────────────────────────────────
// Body: { JobInvoiceID }
// Reverses stage 2: Status flips from 'director_approved' back to 'approved'
// and the audit columns clear. Refuses if the invoice has been marked as
// created in MYOB. Caller MUST hold the 'director' role.
//
// Undoing a director's approval is a decision (PLAN §3.12): the reversal and
// its ledger row commit together or not at all. The row keeps who approved the
// invoice and when, because the reversal clears those stamps.

const UNDO_DIRECTOR_APPROVE_INVOICE_TARGET: RefusalTarget = {
  attempted: "invoice.undo_director_approve",
  idField: "JobInvoiceID",
  subjectType: "invoice",
};

async function undoDirectorApproveJobInvoice(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, ACTION_ROLES.approveInvoiceAsDirector.gate);
  if (denied) {
    await recordRoleRefusal(request, token, denied, UNDO_DIRECTOR_APPROVE_INVOICE_TARGET);
    return denied;
  }

  const userRoles = await rolesForRequest(request);
  if (!userRoles.includes(AppRole.DIRECTOR)) {
    await recordRefusalForRequest(request, token, UNDO_DIRECTOR_APPROVE_INVOICE_TARGET, {
      code: "director_role_required",
      message: "Director role required",
    });
    return { status: 403, jsonBody: { error: "Director role required" } };
  }

  let connection;
  try {
    const body = (await request.json()) as UndoDirectorApproveJobInvoiceBody;
    const { JobInvoiceID } = body ?? {};
    if (typeof JobInvoiceID !== "number") {
      return { status: 400, jsonBody: { error: "JobInvoiceID (number) required" } };
    }

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();

    await beginTransaction(connection);
    try {
      // Locked until commit, so the approval recorded as undone is the one undone.
      const rows = await executeQuery(
        connection,
        `SELECT ${INVOICE_LEDGER_COLUMNS} FROM JobInvoices WITH (UPDLOCK, HOLDLOCK) WHERE JobInvoiceID = @Id`,
        [{ name: "Id", type: TYPES.Int, value: JobInvoiceID }],
      );
      if (rows.length === 0) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: "Invoice not found" } };
      }
      const invoice = rows[0];

      const jobId = invoice.JobID as number;
      const invoiceNumber = (invoice.InvoiceNumber as string | null) ?? `#${JobInvoiceID}`;
      const status = (invoice.Status as string) ?? "pending";
      const myobCreatedAt = invoice.MyobCreatedAt as Date | null;

      if (status !== "director_approved") {
        await rollbackTransaction(connection).catch(() => {});
        return {
          status: 400,
          jsonBody: { error: "Invoice is not director-approved" },
        };
      }
      if (myobCreatedAt != null) {
        // The books already have it: a refused attempt, ledgered in a
        // transaction of its own now that this one has rolled back.
        await rollbackTransaction(connection).catch(() => {});
        const error = "Invoice has been created in MYOB — unmark MYOB first";
        await recordRefusal(
          connection,
          actor,
          { id: JobInvoiceID, type: "invoice" },
          { attempted: "invoice.undo_director_approve", code: "already_in_myob", message: error, state: { status } },
          jobId,
        );
        return { status: 400, jsonBody: { error } };
      }
      // J3: once a payment exists, the director's approval is what it rests on.
      if ((await paymentCount(connection, JobInvoiceID)) > 0) {
        await rollbackTransaction(connection).catch(() => {});
        const refusal: MoneyRefusal = {
          code: "payment_exists",
          message: "A payment is recorded against this invoice, so its director approval can't be undone.",
          status: 409,
        };
        await recordRefusal(
          connection,
          actor,
          { id: JobInvoiceID, type: "invoice" },
          { attempted: "invoice.undo_director_approve", code: refusal.code, message: refusal.message, state: { status } },
          jobId,
        );
        return refusalResponse(refusal);
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

      const scope = await jobScope(connection, jobId);
      const known = await withContractorId(connection, invoice);
      await record(connection, {
        action: "invoice.undo_director_approve",
        actor,
        after: { status: "approved", ...invoiceFacts(known), ...amountUnchanged(known.Amount, approvedAmount(known)) },
        before: invoiceSnapshot(known),
        buildingId: scope.buildingId,
        jobId: scope.jobId,
        subject: { id: JobInvoiceID, type: "invoice" },
      });
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }

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

  const denied = await requireRole(request, [AppRole.ACCOUNTS, AppRole.DIRECTOR, AppRole.FACILITIES]);
  if (denied) return denied;

  let connection;
  try {
    connection = await createRequestConnection(token);
    // Role names go out trimmed and lower-cased, as the authority core reads
    // them, with the director threshold the backend enforces: configured
    // (DIRECTOR_APPROVAL_THRESHOLD, null when unset) and effective (what
    // applies once the limits are taken into account). The Roles page and the
    // frontend mirror build their facts from exactly this.
    const limits = toRoleLimits(await getCachedApprovalLimits(connection));
    const approvalLimits = limits
      .slice()
      .sort((a, b) => a.role.localeCompare(b.role))
      .map((row) => ({ maxApprovalAmount: row.limit, roleName: row.role }));
    const directorThreshold = parseDirectorThreshold(process.env.DIRECTOR_APPROVAL_THRESHOLD);
    const { effectiveDirectorThreshold } = decideAuthority(
      { amount: 0, buildingId: 0, subject: "invoice" },
      { directorThreshold, isResidence: false, limits, residenceApprovers: [], residenceDirectorFallback: true, today: "" },
    );
    // R13: the variance margin and cap beside the limits. Shown only, so a
    // database that hasn't had migration 117 yet shows the defaults.
    const varianceMargin = await loadVarianceFacts(connection).catch(() => DEFAULT_VARIANCE_FACTS);
    // R2: whether attributed quote approval is switched on (ATTRIBUTED_APPROVAL_ENABLED),
    // so the frontend offers it only when the backend will accept it.
    return {
      status: 200,
      jsonBody: { approvalLimits, attributedApprovalEnabled: attributedApprovalEnabled(), directorThreshold, effectiveDirectorThreshold, varianceMargin },
    };
  } catch (error: any) {
    context.error("getApprovalLimits failed:", error.message);
    return errorResponse("Failed to fetch approval limits", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/rejectJobInvoice ────────────────────────────────────────────────
// Body: { JobInvoiceID } — the actor is the verified caller, never the body.
// The rejection and its ledger row commit together or not at all.

const REJECT_INVOICE_TARGET: RefusalTarget = {
  attempted: "invoice.reject",
  idField: "JobInvoiceID",
  subjectType: "invoice",
};

async function rejectJobInvoice(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, ACTION_ROLES.rejectInvoice.gate);
  if (denied) {
    await recordRoleRefusal(request, token, denied, REJECT_INVOICE_TARGET);
    return denied;
  }

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as RejectJobInvoiceBody;
    const { JobInvoiceID } = body ?? {};
    if (typeof JobInvoiceID !== "number") {
      return { status: 400, jsonBody: { error: "JobInvoiceID (number) required" } };
    }

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();

    await beginTransaction(connection);
    try {
      // Locked until commit, so the status recorded as replaced is the one replaced.
      const rows = await executeQuery(
        connection,
        `SELECT JobID, InvoiceNumber, Status, Amount, Direction, ContractorName, SupplierInvoiceNumber, ContractorID, MyobCreatedAt
           FROM JobInvoices WITH (UPDLOCK, HOLDLOCK) WHERE JobInvoiceID = @Id`,
        [{ name: "Id", type: TYPES.Int, value: JobInvoiceID }],
      );
      if (rows.length === 0) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: "Invoice not found" } };
      }
      const invoice = rows[0];

      const jobId = invoice.JobID as number;
      const invoiceNumber = (invoice.InvoiceNumber as string | null) ?? `#${JobInvoiceID}`;

      // J3: an invoice is rejected only before the director, MYOB or a payment
      // have acted on it (undo those first), and only once.
      const current = (invoice.Status as string | null) ?? "pending";
      const settled =
        current === "director_approved" ||
        current === "rejected" ||
        invoice.MyobCreatedAt != null ||
        (await paymentCount(connection, JobInvoiceID)) > 0;
      if (settled) {
        await rollbackTransaction(connection).catch(() => {});
        const refusal: MoneyRefusal = {
          code: "not_rejectable",
          message:
            current === "rejected"
              ? "This invoice is already rejected."
              : "This invoice has a director approval, a MYOB mark or a payment. Undo those before rejecting it.",
          status: 409,
        };
        await recordRefusal(
          connection,
          actor,
          { id: JobInvoiceID, type: "invoice" },
          { attempted: "invoice.reject", code: refusal.code, message: refusal.message, state: { status: current } },
          jobId,
        );
        return refusalResponse(refusal);
      }

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
          { name: "CreatedBy", type: TYPES.NVarChar, value: identity.name },
          { name: "Text", type: TYPES.NVarChar, value: `Rejected invoice ${invoiceNumber}` },
          { name: "InvoiceID", type: TYPES.Int, value: JobInvoiceID },
        ],
      );
      await executeQuery(
        connection,
        "UPDATE Jobs SET LastModifiedDate = SYSUTCDATETIME() WHERE JobID = @JobID",
        [{ name: "JobID", type: TYPES.Int, value: jobId }],
      );

      const scope = await jobScope(connection, jobId);
      const known = await withContractorId(connection, invoice);
      await record(connection, {
        action: "invoice.reject",
        actor,
        after: { status: "rejected", ...invoiceFacts(known) },
        before: { status: (invoice.Status as string | null) ?? null, ...contractorFacts(known) },
        buildingId: scope.buildingId,
        jobId: scope.jobId,
        subject: { id: JobInvoiceID, type: "invoice" },
      });
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }

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
// Body: { JobInvoiceID } — the actor is the verified caller, never the body.
// Records that this invoice has been entered into MYOB. Currently only used
// by outgoing (oncharge) invoices via the InvoicesStep — incoming contractor
// invoices may opt in later when the direct integration lands.
//
// Floorplan makes no MYOB call here: someone has created the invoice in MYOB
// by hand and this stamps that it was done, so there is no MyobApiLog row for
// the ledger row to be correlated with. The stamp and its ledger row commit
// together or not at all.

const MARK_INVOICE_MYOB_TARGET: RefusalTarget = {
  attempted: "invoice.myob_created",
  idField: "JobInvoiceID",
  subjectType: "invoice",
};

async function markJobInvoiceMyobCreated(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, ACTION_ROLES.markInvoiceInMyob.gate);
  if (denied) {
    await recordRoleRefusal(request, token, denied, MARK_INVOICE_MYOB_TARGET);
    return denied;
  }
  // Money action (S11): allowed network, fresh sign-in, MFA. src/money-gated-routes.ts
  const gate = await requireMoneyContext(request);
  if (gate) return gate;

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as MarkJobInvoiceMyobCreatedBody;
    const { JobInvoiceID } = body ?? {};
    if (typeof JobInvoiceID !== "number") {
      return { status: 400, jsonBody: { error: "JobInvoiceID (number) required" } };
    }

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();

    await beginTransaction(connection);
    try {
      // Locked until commit, so the approval we check is the one we act on.
      const rows = await executeQuery(
        connection,
        `SELECT JobID, InvoiceNumber, Status, Amount, Direction, ContractorName, SupplierInvoiceNumber, MyobCreatedAt, ContractorID
           FROM JobInvoices WITH (UPDLOCK, HOLDLOCK) WHERE JobInvoiceID = @Id`,
        [{ name: "Id", type: TYPES.Int, value: JobInvoiceID }],
      );
      if (rows.length === 0) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: "Invoice not found" } };
      }
      const invoice = rows[0];

      const jobId = invoice.JobID as number;
      const invoiceNumber = (invoice.InvoiceNumber as string | null) ?? `#${JobInvoiceID}`;
      const status = (invoice.Status as string) ?? "pending";

      // Decision 4 (J3): admin marks in MYOB on test records only.
      const roles = await rolesForRequest(request);
      const adminBar = adminRefusal(roles, holdsAdmin(roles) && (await isTestJob(connection, jobId)));
      if (adminBar) {
        await rollbackTransaction(connection).catch(() => {});
        await recordRefusal(
          connection,
          actor,
          { id: JobInvoiceID, type: "invoice" },
          { attempted: "invoice.myob_created", code: adminBar.code, message: adminBar.message, state: { status } },
          jobId,
        );
        return refusalResponse(adminBar);
      }
      // Director gate may not have been engaged (e.g. small-amount invoices). Allow
      // MYOB creation when EITHER director_approved OR (approved AND no director was needed).
      // Same gate as approval (J1): an invoice with no amount needs the director.
      const { buildingId } = await jobScope(connection, jobId);
      const { result: authority } = await resolveApprovalAuthority(connection, {
        amount: invoice.Amount == null ? NaN : Number(invoice.Amount),
        buildingId: buildingId ?? 0,
        jobId,
        subject: "invoice",
      });
      const directorWasRequired = authority.directorRequired;
      const fullyApproved =
        status === "director_approved" || (status === "approved" && !directorWasRequired);
      if (!fullyApproved) {
        // Marking an unapproved invoice as created would walk round the
        // approvals: a refused attempt, ledgered in a transaction of its own
        // now that this one has rolled back.
        await rollbackTransaction(connection).catch(() => {});
        const error = directorWasRequired
          ? "Invoice must be director-approved before MYOB creation"
          : "Invoice must be approved before MYOB creation";
        await recordRefusal(
          connection,
          actor,
          { id: JobInvoiceID, type: "invoice" },
          {
            attempted: "invoice.myob_created",
            code: directorWasRequired ? "director_approval_required" : "approval_required",
            message: error,
            state: { status },
          },
          jobId,
        );
        return { status: 400, jsonBody: { error } };
      }

      await executeQuery(
        connection,
        `UPDATE JobInvoices
           SET MyobCreatedAt = SYSUTCDATETIME(), MyobCreatedBy = @CreatedBy
         WHERE JobInvoiceID = @Id`,
        [
          { name: "Id", type: TYPES.Int, value: JobInvoiceID },
          { name: "CreatedBy", type: TYPES.NVarChar, value: identity.name },
        ],
      );
      await executeQuery(
        connection,
        `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, InvoiceID)
         VALUES (@JobID, @CreatedBy, @Text, 'invoice_myob_created', @InvoiceID);`,
        [
          { name: "JobID", type: TYPES.Int, value: jobId },
          { name: "CreatedBy", type: TYPES.NVarChar, value: identity.name },
          { name: "Text", type: TYPES.NVarChar, value: `Marked invoice ${invoiceNumber} as created in MYOB` },
          { name: "InvoiceID", type: TYPES.Int, value: JobInvoiceID },
        ],
      );
      await executeQuery(
        connection,
        "UPDATE Jobs SET LastModifiedDate = SYSUTCDATETIME() WHERE JobID = @JobID",
        [{ name: "JobID", type: TYPES.Int, value: jobId }],
      );

      const scope = await jobScope(connection, jobId);
      const known = await withContractorId(connection, invoice);
      await record(connection, {
        action: "invoice.myob_created",
        actor,
        after: { myobCreated: true, status, ...invoiceFacts(known) },
        // Marking again just re-stamps; the earlier marking shows here.
        before: { myobCreated: invoice.MyobCreatedAt != null, ...contractorFacts(known) },
        buildingId: scope.buildingId,
        jobId: scope.jobId,
        subject: { id: JobInvoiceID, type: "invoice" },
      });
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }

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
// have a downstream "completed" state distinct from approval. The unmarking
// and its ledger row commit together or not at all; the row keeps who marked
// the invoice and when, because unmarking clears those.

const UNMARK_INVOICE_MYOB_TARGET: RefusalTarget = {
  attempted: "invoice.unmark_myob_created",
  idField: "JobInvoiceID",
  subjectType: "invoice",
};

async function unmarkJobInvoiceMyobCreated(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, ACTION_ROLES.markInvoiceInMyob.gate);
  if (denied) {
    await recordRoleRefusal(request, token, denied, UNMARK_INVOICE_MYOB_TARGET);
    return denied;
  }
  // Money action (S11): allowed network, fresh sign-in, MFA. src/money-gated-routes.ts
  const gate = await requireMoneyContext(request);
  if (gate) return gate;

  let connection;
  try {
    const body = (await request.json()) as UnmarkJobInvoiceMyobCreatedBody;
    const { JobInvoiceID } = body ?? {};
    if (typeof JobInvoiceID !== "number") {
      return { status: 400, jsonBody: { error: "JobInvoiceID (number) required" } };
    }

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();

    await beginTransaction(connection);
    try {
      // Locked until commit, so the marking recorded as cleared is the one cleared.
      const rows = await executeQuery(
        connection,
        `SELECT ${INVOICE_LEDGER_COLUMNS} FROM JobInvoices WITH (UPDLOCK, HOLDLOCK) WHERE JobInvoiceID = @Id`,
        [{ name: "Id", type: TYPES.Int, value: JobInvoiceID }],
      );
      if (rows.length === 0) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: "Invoice not found" } };
      }
      const invoice = rows[0];

      const jobId = invoice.JobID as number;
      const invoiceNumber = (invoice.InvoiceNumber as string | null) ?? `#${JobInvoiceID}`;

      // Decision 4 (J3 review): admin un-marks in MYOB on test records only, as it marks.
      const roles = await rolesForRequest(request);
      const adminBar = adminRefusal(roles, holdsAdmin(roles) && (await isTestJob(connection, jobId)));
      if (adminBar) {
        return await refuseMoneyChange(connection, request, {
          attempted: "invoice.unmark_myob_created",
          jobId,
          refusal: adminBar,
          state: { status: (invoice.Status as string | null) ?? null },
          subject: { id: JobInvoiceID, type: "invoice" },
        });
      }

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

      const scope = await jobScope(connection, jobId);
      const known = await withContractorId(connection, invoice);
      await record(connection, {
        action: "invoice.unmark_myob_created",
        actor,
        after: {
          myobCreated: false,
          status: (invoice.Status as string | null) ?? null,
          ...invoiceFacts(known),
          ...amountUnchanged(known.Amount, approvedAmount(known)),
        },
        before: invoiceSnapshot(known),
        buildingId: scope.buildingId,
        jobId: scope.jobId,
        subject: { id: JobInvoiceID, type: "invoice" },
      });
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }

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
// Refuses to delete an invoice anyone has relied on (D5): approved, approved by
// a director, marked in MYOB, or with a payment recorded against it.
//
// A deletion leaves nothing behind but its ledger row, so the row carries a
// snapshot of what was deleted, and the two commit together or not at all.

const DELETE_INVOICE_TARGET: RefusalTarget = {
  attempted: "invoice.delete",
  idField: "JobInvoiceID",
  subjectType: "invoice",
};

/** Why this invoice can't be deleted, or null. `payments` are the statuses of
 *  the payments recorded against it. */
const PAYMENTS_BLOCK_DELETE = "This invoice has payments recorded against it";
const SQL_FK_VIOLATION = 547;

function deleteInvoiceRefusal(
  invoice: { MyobCreatedAt?: unknown; Status?: unknown },
  payments: readonly unknown[],
): { code: string; error: string; status: number } | null {
  if (invoice.Status === "approved") {
    return { code: "approved_invoice_protected", error: "Cannot delete an approved invoice. Reject it first.", status: 400 };
  }
  if (invoice.Status === "director_approved") {
    return {
      code: "approved_invoice_protected",
      error: "Cannot delete an invoice a director has approved. Undo the director approval first.",
      status: 400,
    };
  }
  if (invoice.MyobCreatedAt != null) {
    return { code: "myob_invoice_protected", error: "Cannot delete an invoice marked in MYOB. Undo the MYOB mark first.", status: 400 };
  }
  // Payments.JobInvoiceID references this row (FK_Payments_JobInvoices, migration 114).
  if (payments.length > 0) {
    return { code: "paid_invoice_protected", error: PAYMENTS_BLOCK_DELETE, status: 409 };
  }
  return null;
}

async function deleteJobInvoice(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, ACTION_ROLES.deleteInvoice.gate);
  if (denied) {
    await recordRoleRefusal(request, token, denied, DELETE_INVOICE_TARGET);
    return denied;
  }

  let connection;
  try {
    const body = (await request.json()) as DeleteJobInvoiceBody;
    const { JobInvoiceID } = body ?? {};
    if (typeof JobInvoiceID !== "number") {
      return { status: 400, jsonBody: { error: "JobInvoiceID (number) required" } };
    }

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();

    await beginTransaction(connection);
    try {
      // Locked until commit, so the snapshot is of the invoice that is deleted.
      const rows = await executeQuery(
        connection,
        `SELECT ${INVOICE_LEDGER_COLUMNS} FROM JobInvoices WITH (UPDLOCK, HOLDLOCK) WHERE JobInvoiceID = @Id`,
        [{ name: "Id", type: TYPES.Int, value: JobInvoiceID }],
      );
      if (rows.length === 0) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: "Invoice not found" } };
      }
      const invoice = rows[0];
      const payments = await executeQuery(
        connection,
        "SELECT Status FROM Payments WHERE JobInvoiceID = @Id",
        [{ name: "Id", type: TYPES.Int, value: JobInvoiceID }],
      );
      const refusal = deleteInvoiceRefusal(invoice, payments.map((p) => p.Status));
      if (refusal) {
        // A refused attempt, ledgered in a transaction of its own now that this
        // one has rolled back.
        await rollbackTransaction(connection).catch(() => {});
        await recordRefusal(
          connection,
          actor,
          { id: JobInvoiceID, type: "invoice" },
          {
            attempted: "invoice.delete",
            code: refusal.code,
            message: refusal.error,
            state: { status: String(invoice.Status ?? "") },
          },
          invoice.JobID as number,
        );
        return { status: refusal.status, jsonBody: { error: refusal.error } };
      }

      await executeQuery(
        connection,
        "DELETE FROM JobInvoices WHERE JobInvoiceID = @Id",
        [{ name: "Id", type: TYPES.Int, value: JobInvoiceID }],
      );

      const scope = await jobScope(connection, invoice.JobID as number);
      const known = await withContractorId(connection, invoice);
      await record(connection, {
        action: "invoice.delete",
        actor,
        after: deletionAfter(invoiceFacts(known), approvedAmount(known)),
        before: invoiceSnapshot(known),
        buildingId: scope.buildingId,
        jobId: scope.jobId,
        subject: { id: JobInvoiceID, type: "invoice" },
      });
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }

    return { status: 200, jsonBody: { deleted: true, invoiceId: JobInvoiceID } };
  } catch (error: any) {
    // A payment landed between the check and the delete: the FK says no.
    if (error?.number === SQL_FK_VIOLATION || error?.originalError?.number === SQL_FK_VIOLATION) {
      return { status: 409, jsonBody: { error: PAYMENTS_BLOCK_DELETE } };
    }
    context.error("deleteJobInvoice failed:", error.message);
    return errorResponse("Delete invoice failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/resendDirectorInvoiceEmail ─────────────────────────────────────
// Body: { JobInvoiceID } — the sender is the verified caller, never the body.
// Re-fires the director packet email for an invoice already in the
// awaiting-director state (Status='approved'). Updates the audit columns. A
// send is ledgered once the mail has gone (see ../email/director-requests).

interface ResendDirectorInvoiceEmailBody {
  JobInvoiceID: number;
  /** @deprecated ignored — identity comes from the token */
  TriggeredBy?: string;
}

const RESEND_DIRECTOR_INVOICE_TARGET: RefusalTarget = {
  attempted: "invoice.director_request_sent",
  idField: "JobInvoiceID",
  subjectType: "invoice",
};

async function resendDirectorInvoiceEmail(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  // The director is the one being nudged — restricting resend to them alone
  // means a stalled approval can only be self-chased. Open this to the
  // workflow participants (accounts + facilities) so they can re-trigger
  // the email when the director hasn't acted.
  const denied = await requireRole(request, ACTION_ROLES.resendDirectorEmail.gate);
  if (denied) {
    await recordRoleRefusal(request, token, denied, RESEND_DIRECTOR_INVOICE_TARGET);
    return denied;
  }

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as ResendDirectorInvoiceEmailBody;
    const { JobInvoiceID } = body ?? {};
    if (typeof JobInvoiceID !== "number") {
      return { status: 400, jsonBody: { error: "JobInvoiceID (number) required" } };
    }

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();

    const rows = await executeQuery(
      connection,
      `SELECT JobID, Amount, Status, InvoiceNumber, ContractorName, SupplierInvoiceNumber, Direction, ContractorID
         FROM JobInvoices WHERE JobInvoiceID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: JobInvoiceID }],
    );
    if (rows.length === 0) return { status: 404, jsonBody: { error: "Invoice not found" } };

    const jobId = rows[0].JobID as number;
    const amount = (rows[0].Amount as number | null) ?? 0;
    const status = (rows[0].Status as string) ?? "";

    if (status !== "approved") {
      return { status: 400, jsonBody: { error: "Invoice is not in the awaiting-director state" } };
    }

    await sendDirectorRequest({
      actor,
      amount,
      connection,
      currency: "AUD",
      facts: invoiceFacts(await withContractorId(connection, rows[0])),
      jobId,
      resend: true,
      stage: "invoice",
      subjectId: JobInvoiceID,
      triggeredBy: identity.name,
    });

    const stored = await executeQuery(
      connection,
      `SELECT ${JOB_INVOICE_COLUMNS} FROM JobInvoices WHERE JobInvoiceID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: JobInvoiceID }],
    );
    return { status: 200, jsonBody: { invoice: stored[0] } };
  } catch (error: any) {
    context.error("resendDirectorInvoiceEmail failed:", error.message);
    return errorResponse("Resend director invoice email failed", error.message);
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
app.http("resendDirectorInvoiceEmail", { methods: ["POST"], authLevel: "anonymous", handler: resendDirectorInvoiceEmail });
