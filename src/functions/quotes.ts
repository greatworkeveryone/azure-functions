import { declineDirector, needsDeclineDirector, DIRECTOR_ATTRIBUTION_REQUIRED, notifyProxyDecline } from "../directorDeclineAttribution";
// Quotes — CRUD + approve/reject. A contractor replies to a PO email and
// we materialise their quote here. Approving a quote sets Jobs.ApprovedQuoteID
// and stamps ApprovedBy/ApprovedAt so the Payment step has everything it needs.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES, type Connection } from "tedious";
import {
  beginTransaction,
  buildUpdateSet,
  closeConnection,
  commitTransaction,
  createRequestConnection,
  executeQuery,
  rollbackTransaction,
} from "../db";
import { AppRole, extractToken, requireRole, unauthorizedResponse, errorResponse, rolesForRequest, verifiedIdentityFromRequest } from "../auth";
import { ACTION_ROLES } from "../action-roles";
import {
  MAX_LIST_ROWS,
  parsePagination,
  paginationSqlSuffix,
} from "../pagination";
import {
  INTERNAL_ACRONYM,
  ensureContractorAcronym,
} from "../contractor-acronym-db";
import { loadApprovalFacts, loadNamedUser } from "../approvalAuthority-db";
import type { Attribution } from "../approvalAuthority";
import { approvalOutcome, refusalStatus, type ApprovalRefusalReason } from "../approvalOutcome";
import { raiseAttributionNotice } from "../approvalAttributionNotice";
import { attributedApprovalEnabled, nameableRoles, unlessHeldOff } from "../attributedApproval";
import { quoteAttributionColumnExists } from "../quoteAttributionColumn";
import { formatDocNumber } from "../doc-number";
import { isTestJob } from "../testRecords";
import { requireMoneyContext } from "../moneyGate";
import { amountRefusal, approvableRefusal, creatorRefusal, jobMoneyRefusal, type MoneyRefusal, refusalResponse, rejectReason, samePerson } from "../moneyRules";
import { loadJobForMoney, refuseMoneyChange } from "../moneyJob-db";
import { decideApprovalAmountEdit } from "../edit-effects";
import { isJobAttachmentBlob, PDF_NOT_A_JOB_ATTACHMENT } from "../job-attachment-blob";
import { resolveActivePlannerTasks } from "../planner";
import { syncJobActionTriggersStandalone } from "../jobPlannerSync";
import { advanceJobStatus } from "../jobStatusHelpers";
import { JobEvent } from "../jobStatusMachine";
import { QUOTE_COLUMNS, approveDirectorQuote, rejectQuote as rejectQuoteWrite } from "../quote-decisions";
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
  jobScope,
  quoteFacts,
  quoteSnapshot,
} from "../ledger/moneyDecisions";
import { DirectorRequestClaimedError, sendDirectorRequest, sendDirectorRequestAfterApproval } from "../email/director-requests";
import { recordRefusal, recordRefusalForRequest, recordRoleRefusal, type RefusalTarget } from "../ledger/refusals";
import type { LedgerActor } from "../ledger/types";
import { parseMoneyField } from "../money";
import { showTestParam, TestDataEgressError, testRecordResponse } from "../test-data";

// ── GET /api/getQuotes[?jobId=N][&status=pending|approved|rejected] ─────────

async function getQuotes(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, ACTION_ROLES.viewQuotes.gate);
  if (denied) return denied;

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
  // D9: test quotes, and quotes on test jobs, only with the admin's Show test data on.
  whereParts.push("(IsTest = 0 OR @ShowTest = 1)");
  whereParts.push("(JobID IN (SELECT tj.JobID FROM Jobs tj WHERE tj.IsTest = 0) OR @ShowTest = 1)");
  params.push(await showTestParam(request));
  const whereSql = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

  let connection;
  try {
    connection = await createRequestConnection(token);
    const pagination = parsePagination(request.query);
    const topClause = pagination.active ? "" : `TOP ${MAX_LIST_ROWS} `;

    const rows = await executeQuery(
      connection,
      `SELECT ${topClause}${QUOTE_COLUMNS} FROM Quotes ${whereSql} ORDER BY CreatedAt DESC${paginationSqlSuffix(pagination)}`,
      params,
    );

    // Total is only meaningful when paginating; otherwise count = payload.length.
    let total = rows.length;
    if (pagination.active) {
      const totalRows = await executeQuery(
        connection,
        `SELECT COUNT(*) AS Total FROM Quotes ${whereSql}`,
        params,
      );
      total = (totalRows[0]?.Total as number) ?? rows.length;
    }

    const truncated = !pagination.active && rows.length >= MAX_LIST_ROWS;
    if (truncated) {
      context.warn(`getQuotes: hit MAX_LIST_ROWS ceiling (${MAX_LIST_ROWS}) — caller should paginate`);
    }

    return {
      status: 200,
      jsonBody: {
        count: rows.length,
        quotes: rows,
        total,
        truncated,
        ...(pagination.active
          ? { page: pagination.page, pageSize: pagination.pageSize }
          : {}),
      },
    };
  } catch (error: any) {
    context.error("getQuotes failed:", error.message);
    return errorResponse("Failed to fetch quotes", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/upsertQuote ────────────────────────────────────────────────────

export async function upsertQuote(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, ACTION_ROLES.createQuote.gate);
  if (denied) return denied;

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

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
    } = body ?? {};
    const amount = parseMoneyField(Amount, "Amount");
    if (!amount.ok) return { status: 400, jsonBody: { error: amount.error } };

    connection = await createRequestConnection(token);

    if (QuoteID === undefined) {
      // Create — runs in a tx so the SELECT MAX(Seq) + INSERT pair is atomic.
      if (typeof JobID !== "number") {
        return { status: 400, jsonBody: { error: "JobID (number) required to create a quote" } };
      }
      const badAmount = amountRefusal(amount.value, "Amount", true);
      if (badAmount) return refusalResponse(badAmount);
      if (QuotePDFBlobName != null && !(await isJobAttachmentBlob(connection, JobID, QuotePDFBlobName))) {
        return { status: 400, jsonBody: { error: PDF_NOT_A_JOB_ATTACHMENT } };
      }

      await beginTransaction(connection);
      try {
        // J3: no quotes on internal, done or archived jobs (row locked to commit).
        const moneyJob = await loadJobForMoney(connection, JobID);
        if (!moneyJob) {
          await rollbackTransaction(connection).catch(() => {});
          return { status: 404, jsonBody: { error: "Job not found" } };
        }
        const jobRefusal = jobMoneyRefusal(moneyJob);
        if (jobRefusal) {
          return await refuseMoneyChange(connection, request, {
            attempted: "quote.create",
            jobId: JobID,
            refusal: jobRefusal,
            state: { jobStatus: moneyJob.status },
            subject: { id: JobID, type: "job" },
          });
        }
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
          prefix: "QT",
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
            { name: "Amount", type: TYPES.Decimal, value: amount.value ?? null },
            { name: "Currency", type: TYPES.NVarChar, value: Currency ?? "AUD" },
            { name: "Notes", type: TYPES.NVarChar, value: Notes ?? null },
            { name: "QuotePDFBlobName", type: TYPES.NVarChar, value: QuotePDFBlobName ?? null },
            { name: "SourceEmailID", type: TYPES.Int, value: SourceEmailID ?? null },
            { name: "ReceivedAt", type: TYPES.DateTime2, value: ReceivedAt ?? null },
            { name: "CreatedBy", type: TYPES.NVarChar, value: identity.name },
          ],
        );
        const newId = inserted[0].QuoteID as number;

        // Mirror onto the job's activity feed. Kept inside the tx so the
        // quote + its creation event land atomically; if the event insert
        // fails we don't ship a ghost quote with no history trail.
        const amountLabel =
          typeof amount.value === "number"
            ? ` · $${amount.value.toLocaleString()}`
            : "";
        const contractorLabel = ContractorName ? ` · ${ContractorName}` : "";
        await executeQuery(
          connection,
          `INSERT INTO JobEvents
             (JobID, CreatedBy, [Text], EventType, QuoteID)
           VALUES (@JobID, @CreatedBy, @Text, 'quote_added', @QuoteID);`,
          [
            { name: "JobID", type: TYPES.Int, value: JobID },
            { name: "CreatedBy", type: TYPES.NVarChar, value: identity.name },
            {
              name: "Text",
              type: TYPES.NVarChar,
              value: `Added quote ${quoteNumber}${contractorLabel}${amountLabel}`,
            },
            { name: "QuoteID", type: TYPES.Int, value: newId },
          ],
        );
        // First quote attached advances New/Quote → (Awaiting Approval, facilities).
        // Helper no-ops on subsequent quotes (status already past Quote).
        await advanceJobStatus(connection, JobID, JobEvent.QUOTE_RECEIVED, {
          actor: identity.name,
          quoteId: newId,
          note: `Quote ${quoteNumber} received — awaiting approval.`,
        });

        await commitTransaction(connection);

        const stored = await executeQuery(
          connection,
          `SELECT ${QUOTE_COLUMNS} FROM Quotes WHERE QuoteID = @Id`,
          [{ name: "Id", type: TYPES.Int, value: newId }],
        );
        // Eager-fire the job-bound Planner triggers. The first quote just moved
        // the job to (Awaiting Approval, facilities), so the
        // awaiting_facilities_approval task should appear now rather than waiting
        // for the nightly sweep. All steps are idempotent and no-op when their
        // condition doesn't hold.
        await syncJobActionTriggersStandalone(JobID, (msg) => context.log(msg));
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
    const update = buildUpdateSet(
      {
        Amount: TYPES.Decimal,
        ContractorID: TYPES.Int,
        ContractorName: TYPES.NVarChar,
        Currency: TYPES.NVarChar,
        Notes: TYPES.NVarChar,
        QuotePDFBlobName: TYPES.NVarChar,
      },
      { Amount: amount.value, ContractorID, ContractorName, Currency, Notes, QuotePDFBlobName },
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
      // Read the existing quote before mutating so we can diff for the audit
      // trail and detect whether the edit invalidates a prior approval. Locked
      // until commit, so the approval recorded as reset is the one reset.
      const beforeRows = await executeQuery(
        connection,
        `SELECT ${QUOTE_LEDGER_COLUMNS} FROM Quotes WITH (UPDLOCK, HOLDLOCK) WHERE QuoteID = @Id`,
        [{ name: "Id", type: TYPES.Int, value: QuoteID }],
      );
      if (beforeRows.length === 0) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: "Quote not found" } };
      }
      const before = beforeRows[0];
      const jobId = before.JobID as number;
      if (QuotePDFBlobName != null && !(await isJobAttachmentBlob(connection, jobId, QuotePDFBlobName))) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 400, jsonBody: { error: PDF_NOT_A_JOB_ATTACHMENT } };
      }
      const quoteNumber = (before.QuoteNumber as string | null) ?? `#${QuoteID}`;

      // J3: the job still takes money changes (not internal, done or archived).
      const moneyJob = await loadJobForMoney(connection, jobId);
      const jobRefusal = moneyJob ? jobMoneyRefusal(moneyJob) : null;
      if (jobRefusal) {
        return await refuseMoneyChange(connection, request, {
          attempted: "quote.edit",
          jobId,
          refusal: jobRefusal,
          state: { jobStatus: moneyJob?.status ?? null, status: before.Status ?? null },
          subject: { id: QuoteID, type: "quote" },
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
        { amount: amount.value, contractorId: ContractorID, contractorName: ContractorName },
      );

      await executeQuery(
        connection,
        `UPDATE Quotes SET ${update.setClause} WHERE QuoteID = @Id`,
        [{ name: "Id", type: TYPES.Int, value: QuoteID }, ...update.params],
      );

      await executeQuery(
        connection,
        `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, QuoteID)
         VALUES (@JobID, @CreatedBy, @Text, 'quote_edited', @QuoteID);`,
        [
          { name: "JobID", type: TYPES.Int, value: jobId },
          { name: "CreatedBy", type: TYPES.NVarChar, value: identity.name },
          {
            name: "Text",
            type: TYPES.NVarChar,
            value: `Edited quote ${quoteNumber}: ${effects.summary}`,
          },
          { name: "QuoteID", type: TYPES.Int, value: QuoteID },
        ],
      );

      // A changed amount or payee on an approved quote tears the approval down
      // so the next reviewer re-runs the authority check (J3: the approver
      // approved paying this amount to this contractor). N2 (J2): the job's
      // status is never changed here; only the approval is cleared.
      if (effects.clearApproval) {
        const CLEARS = await clearAttributionSql(connection);
        await executeQuery(
          connection,
          `UPDATE Quotes
              SET Status = 'pending',
                  ApprovedAt = NULL, ApprovedBy = NULL,
                  DirectorApprovedAt = NULL, DirectorApprovedBy = NULL,
                  DirectorEmailAttemptedAt = NULL,
                  DirectorEmailSentAt = NULL, DirectorEmailSentTo = NULL,
                  DirectorEmailSentBy = NULL${CLEARS}
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
        const why = effects.contractorChanged ? "payee_changed" : "amount_changed";
        await executeQuery(
          connection,
          `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, QuoteID)
           VALUES (@JobID, @CreatedBy, @Text, @EventType, @QuoteID);`,
          [
            { name: "JobID", type: TYPES.Int, value: jobId },
            { name: "CreatedBy", type: TYPES.NVarChar, value: identity.name },
            {
              name: "Text",
              type: TYPES.NVarChar,
              value: `Quote ${quoteNumber} ${effects.contractorChanged ? "contractor" : "amount"} changed — approval cleared. The job keeps its status until a quote is approved again.`,
            },
            { name: "EventType", type: TYPES.NVarChar, value: "quote_approval_cleared" },
            { name: "QuoteID", type: TYPES.Int, value: QuoteID },
          ],
        );

        // Only an edit that carries an amount or a payee can get here, and
        // those looked up who is editing above.
        if (!actor) throw new Error("An approval was reset without a ledger actor");
        const scope = await jobScope(connection, jobId);
        const edited = {
          ...before,
          Amount: amount.value !== undefined ? amount.value : before.Amount,
          ContractorID: ContractorID !== undefined ? ContractorID : before.ContractorID,
          ContractorName: ContractorName !== undefined ? ContractorName : before.ContractorName,
          Currency: Currency !== undefined ? Currency : before.Currency,
        };
        await record(connection, {
          action: "quote.approval_reset",
          actor,
          after: {
            ...quoteFacts(edited),
            ...amountChange({ approved: before.Amount, next: edited.Amount, previous: before.Amount }),
            status: "pending",
          },
          before: approvalSnapshot(before),
          buildingId: scope.buildingId,
          jobId: scope.jobId,
          ruleApplied: why,
          subject: { id: QuoteID, type: "quote" },
        });
      }

      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }

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
// Body: { QuoteID } — the approver is the verified caller, never the body.
// Sets Quotes.Status='approved' + ApprovedBy/ApprovedAt, and mirrors the id
// onto Jobs.ApprovedQuoteID / ApprovedBy / ApprovedAt so the Payment step
// sees the approval without re-reading the Quotes table.
//
// The approval is a decision (PLAN §3.12): its writes and its ledger row
// commit together or not at all. Routing the quote up to a director or a more
// senior approver is part of the same decision and is ledgered as quote.approve
// with the status it landed in.

interface ApproveQuoteBody {
  QuoteID?: unknown;
  /** R2: plain facilities names the manager they discussed it with (AppUsers.UserID)... */
  attributedToUserId?: unknown;
  /** ...and declares that they did. Roles are read from AppUsers, never sent. */
  declared?: unknown;
  /** @deprecated ignored — identity comes from the token */
  ApprovedBy?: string;
}

const APPROVE_QUOTE_TARGET: RefusalTarget = { attempted: "quote.approve", idField: "QuoteID", subjectType: "quote" };

interface QuoteApproval {
  amount: number;
  /** The manager an attributed approval was agreed with (R2), for their notice. */
  attributedToUserId: number | null;
  currency: string;
  directorNeeded: boolean;
  /** The quote's ledger facts, for the director request that may follow. */
  facts: Record<string, unknown>;
  jobId: number;
  newStatus: string;
}

type QuoteApprovalOutcome =
  | { approval: QuoteApproval; ok: true }
  | { ok: false; response: HttpResponseInit }
  | { jobId: number; ok: false; refusal: ApprovalRefusal };

/** A refused approval: what the ledger records (`sod_blocked` for self-approval) and what the caller sees. */
interface ApprovalRefusal {
  action: "denied" | "sod_blocked";
  code: ApprovalRefusalReason | string;
  httpStatus: number;
  message: string;
  status: string | null;
}

function approvalRefusal(refusal: MoneyRefusal, quoteStatus: string | null): ApprovalRefusal {
  return {
    action: refusal.code === "creator" ? "sod_blocked" : "denied",
    code: refusal.code,
    httpStatus: refusal.status,
    message: refusal.message,
    status: quoteStatus,
  };
}

/** Clears an attribution that no longer applies; the ledger keeps the history. */
const CLEAR_ATTRIBUTION = ", ApprovalAttributedToUserID = NULL, ApprovalAttributionDeclaredAt = NULL, AttributionAnsweredAt = NULL";

/** CLEAR_ATTRIBUTION once migration 117's columns exist; nothing while 117 is pending, so quote writes keep working. */
async function clearAttributionSql(connection: Connection): Promise<string> {
  return (await quoteAttributionColumnExists(connection)) ? CLEAR_ATTRIBUTION : "";
}

async function approveQuoteInTransaction(
  connection: Connection,
  input: {
    actor: LedgerActor;
    approvedBy: string;
    /** R2: the manager named, and whether the officer declared they discussed it. */
    attribution: { declared: boolean; userId: number | null };
    correlationId: string;
    email: string;
    quoteId: number;
    userRoles: string[];
  },
): Promise<QuoteApprovalOutcome> {
  const { actor, approvedBy, correlationId, email, quoteId, userRoles } = input;
  await beginTransaction(connection);
  try {
    // Locked until commit, so the status we record as replaced is the one we replace.
    const quoteRows = await executeQuery(
      connection,
      "SELECT JobID, QuoteNumber, ContractorName, Amount, ISNULL(Currency, 'AUD') AS Currency, Status, ContractorID, CreatedBy FROM Quotes WITH (UPDLOCK, HOLDLOCK) WHERE QuoteID = @Id",
      [{ name: "Id", type: TYPES.Int, value: quoteId }],
    );
    if (quoteRows.length === 0) {
      await rollbackTransaction(connection).catch(() => {});
      return { ok: false, response: { status: 404, jsonBody: { error: "Quote not found" } } };
    }
    const quote = quoteRows[0];
    const jobId = quote.JobID as number;
    const quoteNumber = (quote.QuoteNumber as string | null) ?? `#${quoteId}`;
    const contractorName = quote.ContractorName as string | null;
    // The director email shows the amount; an unknown one reads as 0.00 there,
    // but is never treated as $0 by the authority check below.
    const amount = Number(quote.Amount ?? 0);
    const currency = quote.Currency as string;
    const quoteStatus = (quote.Status as string | null) ?? null;

    // J3, in order: the job takes money changes; the quote is still waiting
    // for a decision; whoever added it doesn't approve it (unless a director,
    // decision 17); and the job has no other approved quote (a second one
    // would overwrite Jobs.ApprovedQuoteID).
    const moneyJob = await loadJobForMoney(connection, jobId);
    const stateRefusal =
      (moneyJob ? jobMoneyRefusal(moneyJob) : null) ??
      approvableRefusal(quoteStatus, "quote") ??
      creatorRefusal(quote.CreatedBy, { name: approvedBy, roles: userRoles }, "quote") ??
      (moneyJob?.hasApprovedQuote
        ? { code: "quote_already_approved", message: "This job already has an approved quote. Deselect it before approving another.", status: 409 as const }
        : null);
    if (stateRefusal) {
      await rollbackTransaction(connection).catch(() => {});
      return { jobId, ok: false, refusal: approvalRefusal(stateRefusal, quoteStatus) };
    }

    // The approval-authority core decides (J1): approved on the caller's own
    // authority; past the director threshold (or with no amount) to the
    // director; past the caller's limit to someone further up the route; any
    // other "no" is refused with its reason, admin on a real record included.
    const scope = await jobScope(connection, jobId);
    const facts = await loadApprovalFacts(connection, scope.buildingId);
    const isTest = userRoles.some((role) => role.trim().toLowerCase() === AppRole.ADMIN) && (await isTestJob(connection, jobId));
    // R2: the named manager's roles come from AppUsers, and only the manager
    // roles count (never admin, decision 4; never an accounts clerk's own row).
    // Someone who isn't an active user is named with no roles, so the core
    // finds them invalid; an attribution that wasn't declared isn't one
    // (attribution_required). Whoever added the quote can't be the one who
    // agreed to it (J3: no self-approval by proxy).
    let attribution: Attribution | undefined;
    if (input.attribution.declared && input.attribution.userId !== null) {
      const named = await loadNamedUser(connection, input.attribution.userId);
      if (named && samePerson(quote.CreatedBy, named.displayName)) {
        await rollbackTransaction(connection).catch(() => {});
        return {
          jobId,
          ok: false,
          refusal: {
            action: "denied",
            code: "attribution_invalid",
            httpStatus: 422,
            message: `${named.displayName} added this quote, so they can't be the manager who agreed to it. Name someone else.`,
            status: quoteStatus,
          },
        };
      }
      attribution = {
        attributedTo: named
          ? { displayName: named.displayName, email: named.email, roles: nameableRoles(named.roles), userId: named.userId }
          : { roles: [], userId: input.attribution.userId },
      };
    }
    const outcome = approvalOutcome(
      { email, roles: userRoles, userId: actor.kind === "user" ? (actor.userId ?? undefined) : undefined },
      { amount: quote.Amount == null ? NaN : Number(quote.Amount), attribution, buildingId: scope.buildingId ?? 0, jobId, subject: "quote" },
      facts,
      { isTest },
    );
    if (outcome.kind === "refused") {
      await rollbackTransaction(connection).catch(() => {});
      return {
        jobId,
        ok: false,
        refusal: { action: "denied", code: outcome.reason, httpStatus: refusalStatus(outcome.reason), message: outcome.message, status: quoteStatus },
      };
    }
    const attributedTo = outcome.kind === "approved" && outcome.basis === "attributed" ? (outcome.attributedTo ?? null) : null;
    const attributedName = attributedTo ? (attributedTo.displayName?.trim() || attributedTo.email || `User ${attributedTo.userId}`) : null;
    const userCanApprove = outcome.kind === "approved";
    const directorNeeded = outcome.kind === "awaiting_director";
    const newStatus: string = outcome.kind;
    const CLEARS = attributedTo ? "" : await clearAttributionSql(connection);

    await executeQuery(
      connection,
      attributedTo
        ? `UPDATE Quotes
             SET Status = @Status, ApprovedAt = SYSUTCDATETIME(), ApprovedBy = @ApprovedBy,
                 ApprovalAttributedToUserID = @AttributedTo, ApprovalAttributionDeclaredAt = SYSUTCDATETIME(),
                 AttributionAnsweredAt = NULL
           WHERE QuoteID = @Id`
        : `UPDATE Quotes
             SET Status = @Status, ApprovedAt = SYSUTCDATETIME(), ApprovedBy = @ApprovedBy${CLEARS}
           WHERE QuoteID = @Id`,
      [
        { name: "Id", type: TYPES.Int, value: quoteId },
        { name: "Status", type: TYPES.NVarChar, value: newStatus },
        { name: "ApprovedBy", type: TYPES.NVarChar, value: approvedBy },
        ...(attributedTo ? [{ name: "AttributedTo", type: TYPES.Int, value: attributedTo.userId ?? null }] : []),
      ],
    );

    // Only set Jobs.ApprovedQuoteID when the quote is FULLY approved (no further sign-off needed).
    if (newStatus === "approved") {
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
    } else {
      await executeQuery(
        connection,
        `UPDATE Jobs SET LastModifiedDate = SYSUTCDATETIME() WHERE JobID = @JobID`,
        [{ name: "JobID", type: TYPES.Int, value: jobId }],
      );
    }

    const quoteLabel = `${quoteNumber}${contractorName ? ` from ${contractorName}` : ""}`;
    const eventText =
      attributedName
        ? `Approved by ${approvedBy}, agreed with ${attributedName} — ${quoteLabel}`
        : newStatus === "approved"
        ? `Approved ${quoteLabel}`
        : newStatus === "awaiting_director"
          ? `Selected ${quoteLabel} — awaiting director`
          : `Selected ${quoteLabel} — awaiting approval`;
    const eventType =
      newStatus === "approved"
        ? "quote_approved"
        : newStatus === "awaiting_director"
          ? "quote_awaiting_director"
          : "quote_awaiting_approval";

    await executeQuery(
      connection,
      `INSERT INTO JobEvents
         (JobID, CreatedBy, [Text], EventType, QuoteID)
       VALUES (@JobID, @CreatedBy, @Text, @EventType, @QuoteID);`,
      [
        { name: "JobID", type: TYPES.Int, value: jobId },
        { name: "CreatedBy", type: TYPES.NVarChar, value: approvedBy },
        { name: "Text", type: TYPES.NVarChar, value: eventText },
        { name: "EventType", type: TYPES.NVarChar, value: eventType },
        { name: "QuoteID", type: TYPES.Int, value: quoteId },
      ],
    );

    // Full approval advances the job to (Work, facilities). Quotes still
    // awaiting director / accounts sign-off don't move status — they stay
    // in (Awaiting Approval, facilities) until the final approval lands.
    if (newStatus === "approved") {
      await advanceJobStatus(connection, jobId, JobEvent.QUOTE_APPROVED, {
        actor: approvedBy,
        quoteId,
        note: `Quote ${quoteLabel} approved — ready for PO.`,
      });
    }

    // R2: an approval resting on a named manager is its own code, the officer
    // as actor and the manager as attributedTo (the ledger refuses it otherwise).
    await record(connection, {
      action: attributedTo ? "quote.approve_attributed" : "quote.approve",
      actor,
      after: { status: newStatus, ...quoteFacts(quote) },
      attributedTo: attributedTo
        ? { name: attributedName ?? "", role: attribution?.attributedTo.roles[0] ?? "", userId: attributedTo.userId ?? null }
        : undefined,
      before: { status: (quote.Status as string | null) ?? null, ...contractorFacts(quote) },
      buildingId: scope.buildingId,
      correlationId,
      jobId: scope.jobId,
      ruleApplied: attributedTo ? "attributed" : approvalRule({ directorNeeded, userCanApprove }),
      subject: { id: quoteId, type: "quote" },
    });

    await commitTransaction(connection);
    return {
      ok: true,
      approval: { amount, attributedToUserId: attributedTo?.userId ?? null, currency, directorNeeded, facts: quoteFacts(quote), jobId, newStatus },
    };
  } catch (err) {
    await rollbackTransaction(connection).catch(() => {});
    throw err;
  }
}

async function approveQuote(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  // J4's table: plain facilities is a `conditional` role on approveQuote, let
  // past the gate only while ATTRIBUTED_APPROVAL_ENABLED="true" (held off,
  // decisions 1 and 9); the handler then admits them on the attributed path only.
  const denied = await requireRole(request, ACTION_ROLES.approveQuote.gate.filter(unlessHeldOff(ACTION_ROLES.approveQuote)));
  if (denied) {
    await recordRoleRefusal(request, token, denied, APPROVE_QUOTE_TARGET);
    return denied;
  }

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const approvedBy = identity.name;

  let connection;
  try {
    const body = ((await request.json()) ?? {}) as ApproveQuoteBody;
    const { QuoteID, attributedToUserId, declared } = body;
    if (typeof QuoteID !== "number") {
      return { status: 400, jsonBody: { error: "QuoteID (number) required" } };
    }
    const namedId = attributedToUserId ?? null;
    if (namedId !== null && (typeof namedId !== "number" || !Number.isInteger(namedId) || namedId <= 0)) {
      return { status: 400, jsonBody: { error: "attributedToUserId must be a user id" } };
    }
    if (declared !== undefined && typeof declared !== "boolean") {
      return { status: 400, jsonBody: { error: "declared must be true or false" } };
    }

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();

    // The approval and the director request it triggers are one operation.
    const correlationId = newCorrelationId();
    const outcome = await approveQuoteInTransaction(connection, {
      actor,
      approvedBy,
      // Held off (decisions 1, 9): with the switch unset an attribution is ignored.
      attribution: attributedApprovalEnabled() ? { declared: declared === true, userId: namedId } : { declared: false, userId: null },
      correlationId,
      email: identity.email,
      quoteId: QuoteID,
      userRoles: await rolesForRequest(request),
    });
    if (!outcome.ok) {
      if ("response" in outcome) return outcome.response;
      const { action, code, httpStatus, message, status } = outcome.refusal;
      // Ledgered in a transaction of its own now that the decision's has rolled back.
      return await refuseMoneyChange(connection, request, {
        action,
        attempted: "quote.approve",
        jobId: outcome.jobId,
        refusal: { code, message, status: httpStatus as MoneyRefusal["status"] },
        state: { status },
        subject: { id: QuoteID, type: "quote" },
      });
    }
    const { amount, attributedToUserId: managerUserId, currency, directorNeeded, facts, jobId, newStatus } = outcome.approval;

    // R2: the named manager is told, and can say "I didn't agree to this".
    if (managerUserId !== null) {
      await raiseAttributionNotice(connection, { actor, managerUserId, ref: { id: QuoteID, jobId, kind: "quote" } });
    }

    // Director email, awaited: the Functions host does not guarantee work after
    // the response returns, so the send (and its stamp and ledger rows) finish
    // first. Packet build + Graph sendMail can take 5-20s with attachments; the
    // client allows 45s. The approval has already happened, so a failed send is
    // flagged (directorEmailFailed), not an error; the Resend button recovers.
    let directorEmailFailed = false;
    if (directorNeeded) {
      directorEmailFailed = await sendDirectorRequestAfterApproval(
        {
          actor,
          amount,
          connection,
          correlationId,
          currency,
          facts,
          jobId,
          resend: false,
          stage: "quote",
          subjectId: QuoteID,
          triggeredBy: approvedBy,
        },
        (msg) => context.warn(msg),
      );
    }

    const stored = await executeQuery(
      connection,
      `SELECT ${QUOTE_COLUMNS} FROM Quotes WHERE QuoteID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: QuoteID }],
    );

    // Eager-fire the job-bound Planner triggers. Status='awaiting_director'
    // means the director_approval count for this job has just gone up; the
    // combined sync also re-checks the other three (all idempotent).
    if (newStatus === "awaiting_director") {
      await syncJobActionTriggersStandalone(jobId, (msg) => context.log(msg));
    }

    return { status: 200, jsonBody: directorEmailFailed ? { directorEmailFailed, quote: stored[0] } : { quote: stored[0] } };
  } catch (error: any) {
    context.error("approveQuote failed:", error.message);
    return errorResponse("Approve quote failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/rejectQuote ────────────────────────────────────────────────────

// The quote card offers Reject only on 'pending'; an 'awaiting_director'
// quote may also be turned down. Anything else is a 409 from the helper.
const IN_APP_REJECTABLE_STATUSES = ["pending", "awaiting_director"] as const;

interface RejectQuoteBody {
  AttributedDirectorUserId?: unknown;
  QuoteID?: unknown;
  /** Why it is turned down; required when declining a quote that waits on a director (J6). */
  Reason?: unknown;
}

const REJECT_QUOTE_TARGET: RefusalTarget = { attempted: "quote.reject", idField: "QuoteID", subjectType: "quote" };

export async function rejectQuote(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, ACTION_ROLES.manageQuotes.gate);
  if (denied) {
    await recordRoleRefusal(request, token, denied, REJECT_QUOTE_TARGET);
    return denied;
  }

  // Actor from the verified token. A RejectedBy in the body is ignored.
  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  let connection;
  try {
    const body = ((await request.json().catch(() => null)) ?? {}) as RejectQuoteBody;
    const { QuoteID } = body;
    if (typeof QuoteID !== "number") {
      return { status: 400, jsonBody: { error: "QuoteID (number) required" } };
    }
    const reason = rejectReason(body.Reason);

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();

    // Shared with recordEmailQuoteDecision — src/quote-decisions.ts. The
    // rejection and its ledger row commit or roll back together.
    await beginTransaction(connection);
    let outcome;
    try {
      const current = await executeQuery(connection, "SELECT Status FROM Quotes WITH (UPDLOCK, HOLDLOCK) WHERE QuoteID=@Id", [{ name: "Id", type: TYPES.Int, value: QuoteID }]);
      const waiting = current[0]?.Status === "awaiting_director";
      const attributedDirector = await declineDirector(connection, actor, waiting, body.AttributedDirectorUserId);
      if (needsDeclineDirector(actor, waiting) && reason !== null && !attributedDirector) {
        await rollbackTransaction(connection);
        await recordRefusal(connection, actor, { id: QuoteID, type: "quote" },
          { attempted: "quote.reject", code: "decline_director_required", message: DIRECTOR_ATTRIBUTION_REQUIRED.jsonBody.error }, null);
        return DIRECTOR_ATTRIBUTION_REQUIRED;
      }
      outcome = await rejectQuoteWrite(connection, {
        byDirector: actor.kind === "user" && actor.role === AppRole.DIRECTOR,
        expectedStatuses: IN_APP_REJECTABLE_STATUSES,
        note: reason,
        quoteId: QuoteID,
        reasonRequiredFrom: ["awaiting_director"],
        rejectedBy: identity.name,
      });
      if (!outcome.ok) {
        await rollbackTransaction(connection).catch(() => {});
        if ("code" in outcome) {
          // A decline without its reason (J6): a refused attempt, ledgered.
          const asDirector = actor.kind === "user" && actor.role === AppRole.DIRECTOR;
          await recordRefusal(
            connection,
            actor,
            { id: QuoteID, type: "quote" },
            { attempted: asDirector ? "quote.director_reject" : "quote.reject", code: outcome.code, message: outcome.error },
            outcome.jobId,
          );
          return { status: outcome.status, jsonBody: { code: outcome.code, error: outcome.error } };
        }
        return { status: outcome.status, jsonBody: { error: outcome.error } };
      }
      const scope = await jobScope(connection, outcome.jobId);
      await record(connection, {
        // A director turning down a quote that was waiting for them is the
        // director's own decision; anyone else's rejection is a plain one.
        action:
          outcome.previousStatus === "awaiting_director" && actor.kind === "user" && actor.role === AppRole.DIRECTOR
            ? "quote.director_reject"
            : "quote.reject",
        actor,
        ...(attributedDirector ? { attributedTo: attributedDirector } : {}),
        after: { status: "rejected", ...quoteFacts(outcome.quote) },
        before: { status: outcome.previousStatus ?? null, ...contractorFacts(outcome.quote) },
        buildingId: scope.buildingId,
        jobId: scope.jobId,
        reason,
        subject: { id: QuoteID, type: "quote" },
      });
      if (attributedDirector) await notifyProxyDecline(connection, { actor, director: attributedDirector, kind: "quote", id: QuoteID, jobId: outcome.jobId, reason });
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }

    // Rejecting from awaiting_director closes the director's Planner task. Best-effort.
    if (outcome.previousStatus === "awaiting_director") {
      try {
        await resolveActivePlannerTasks("job", outcome.jobId, ["director_approval"]);
      } catch (err: unknown) {
        context.warn("plannerResolve (rejectQuote):", err instanceof Error ? err.message : String(err));
      }
    }
    return { status: 200, jsonBody: { quote: outcome.quote } };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("rejectQuote failed:", message);
    return errorResponse("Reject quote failed", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// What the ledger needs to know about a quote that is about to change or go.
const QUOTE_LEDGER_COLUMNS = `JobID, QuoteNumber, ContractorID, ContractorName, Amount, Currency, Status,
  ApprovedAt, ApprovedBy, DirectorApprovedAt, DirectorApprovedBy, QuotePDFBlobName`;

// ── POST /api/unapproveQuote ─────────────────────────────────────────────────
// Body: { QuoteID } — the actor is the verified caller.
// Reverts an approved quote back to 'pending' — clears Quote approval
// stamps, nulls Jobs.ApprovedQuoteID (only if this quote was the approved
// one — guards against a race where a different quote got approved in the
// meantime), and logs an event. Refused if any Payment has been recorded
// against the quote: money has moved, unapproval is no longer safe.
//
// Undoing an approval is a decision (PLAN §3.12): the reversal and its ledger
// row commit together or not at all. The row keeps who approved the quote and
// when, because the reversal clears those stamps.

const UNAPPROVE_QUOTE_TARGET: RefusalTarget = { attempted: "quote.unapprove", idField: "QuoteID", subjectType: "quote" };

async function unapproveQuote(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, ACTION_ROLES.unapproveQuote.gate);
  if (denied) {
    await recordRoleRefusal(request, token, denied, UNAPPROVE_QUOTE_TARGET);
    return denied;
  }

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const { QuoteID } = body ?? {};
    if (typeof QuoteID !== "number") {
      return { status: 400, jsonBody: { error: "QuoteID (number) required" } };
    }

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();

    await beginTransaction(connection);
    try {
      // Locked until commit, so the approval recorded as undone is the one undone.
      const rows = await executeQuery(
        connection,
        `SELECT ${QUOTE_LEDGER_COLUMNS} FROM Quotes WITH (UPDLOCK, HOLDLOCK) WHERE QuoteID = @Id`,
        [{ name: "Id", type: TYPES.Int, value: QuoteID }],
      );
      if (rows.length === 0) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: "Quote not found" } };
      }
      const quote = rows[0];
      if (quote.Status !== "approved") {
        await rollbackTransaction(connection).catch(() => {});
        return {
          status: 400,
          jsonBody: { error: "Only approved quotes can be unapproved." },
        };
      }
      const jobId = quote.JobID as number;
      const quoteNumber =
        (quote.QuoteNumber as string | null) ?? `#${QuoteID}`;

      const paymentCount = await executeQuery(
        connection,
        "SELECT COUNT(*) AS N FROM Payments WHERE QuoteID = @Id",
        [{ name: "Id", type: TYPES.Int, value: QuoteID }],
      );
      if ((paymentCount[0]?.N as number) > 0) {
        // Money has moved: a refused attempt, ledgered in a transaction of its
        // own now that this one has rolled back.
        await rollbackTransaction(connection).catch(() => {});
        const error = "Cannot unapprove — a payment has already been recorded against this quote.";
        await recordRefusal(
          connection,
          actor,
          { id: QuoteID, type: "quote" },
          { attempted: "quote.unapprove", code: "payment_recorded", message: error, state: { status: "approved" } },
          jobId,
        );
        return { status: 400, jsonBody: { error } };
      }

      const CLEARS = await clearAttributionSql(connection);
      await executeQuery(
        connection,
        `UPDATE Quotes
           SET Status = 'pending', ApprovedAt = NULL, ApprovedBy = NULL${CLEARS}
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
          { name: "CreatedBy", type: TYPES.NVarChar, value: identity.name },
          {
            name: "Text",
            type: TYPES.NVarChar,
            value: `Unapproved quote ${quoteNumber}`,
          },
          { name: "QuoteID", type: TYPES.Int, value: QuoteID },
        ],
      );

      const scope = await jobScope(connection, jobId);
      await record(connection, {
        action: "quote.unapprove",
        actor,
        after: { status: "pending", ...quoteFacts(quote), ...amountUnchanged(quote.Amount, approvedAmount(quote)) },
        before: quoteSnapshot(quote),
        buildingId: scope.buildingId,
        jobId: scope.jobId,
        subject: { id: QuoteID, type: "quote" },
      });
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }

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

// ── POST /api/completeQuote ──────────────────────────────────────────────────
// Body: { QuoteID } — the actor is the verified caller.
// Marks an approved quote as 'completed' — work has been done and the job is
// waiting on an invoice. Only allowed from 'approved'; logs a job event. The
// status and its ledger row commit together or not at all.

const COMPLETE_QUOTE_TARGET: RefusalTarget = { attempted: "quote.complete", idField: "QuoteID", subjectType: "quote" };

async function completeQuote(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, ACTION_ROLES.manageQuotes.gate);
  if (denied) {
    await recordRoleRefusal(request, token, denied, COMPLETE_QUOTE_TARGET);
    return denied;
  }

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const { QuoteID } = body ?? {};
    if (typeof QuoteID !== "number") {
      return { status: 400, jsonBody: { error: "QuoteID (number) required" } };
    }

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();

    await beginTransaction(connection);
    try {
      // Locked until commit, so the status recorded as replaced is the one replaced.
      const rows = await executeQuery(
        connection,
        `SELECT ${QUOTE_LEDGER_COLUMNS} FROM Quotes WITH (UPDLOCK, HOLDLOCK) WHERE QuoteID = @Id`,
        [{ name: "Id", type: TYPES.Int, value: QuoteID }],
      );
      if (rows.length === 0) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: "Quote not found" } };
      }
      const quote = rows[0];
      if (quote.Status !== "approved") {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 400, jsonBody: { error: "Only approved quotes can be marked completed." } };
      }
      const jobId = quote.JobID as number;
      const quoteNumber = (quote.QuoteNumber as string | null) ?? `#${QuoteID}`;

      await executeQuery(
        connection,
        "UPDATE Quotes SET Status = 'completed' WHERE QuoteID = @Id",
        [{ name: "Id", type: TYPES.Int, value: QuoteID }],
      );
      await executeQuery(
        connection,
        `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, QuoteID)
         VALUES (@JobID, @CreatedBy, @Text, 'quote_completed', @QuoteID);`,
        [
          { name: "JobID", type: TYPES.Int, value: jobId },
          { name: "CreatedBy", type: TYPES.NVarChar, value: identity.name },
          { name: "Text", type: TYPES.NVarChar, value: `Marked work completed on ${quoteNumber}` },
          { name: "QuoteID", type: TYPES.Int, value: QuoteID },
        ],
      );
      await executeQuery(
        connection,
        "UPDATE Jobs SET LastModifiedDate = SYSUTCDATETIME() WHERE JobID = @JobID",
        [{ name: "JobID", type: TYPES.Int, value: jobId }],
      );

      const scope = await jobScope(connection, jobId);
      await record(connection, {
        action: "quote.complete",
        actor,
        after: { status: "completed", ...quoteFacts(quote) },
        before: { status: "approved", ...contractorFacts(quote) },
        buildingId: scope.buildingId,
        jobId: scope.jobId,
        subject: { id: QuoteID, type: "quote" },
      });
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }

    const stored = await executeQuery(
      connection,
      `SELECT ${QUOTE_COLUMNS} FROM Quotes WHERE QuoteID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: QuoteID }],
    );
    return { status: 200, jsonBody: { quote: stored[0] } };
  } catch (error: any) {
    context.error("completeQuote failed:", error.message);
    return errorResponse("Complete quote failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/uncompleteQuote ────────────────────────────────────────────────
// Body: { QuoteID } — the actor is the verified caller.
// Reverts a completed quote back to 'approved' — "Work remaining". The
// reversal and its ledger row commit together or not at all.

const UNCOMPLETE_QUOTE_TARGET: RefusalTarget = { attempted: "quote.uncomplete", idField: "QuoteID", subjectType: "quote" };

async function uncompleteQuote(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, ACTION_ROLES.manageQuotes.gate);
  if (denied) {
    await recordRoleRefusal(request, token, denied, UNCOMPLETE_QUOTE_TARGET);
    return denied;
  }

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const { QuoteID } = body ?? {};
    if (typeof QuoteID !== "number") {
      return { status: 400, jsonBody: { error: "QuoteID (number) required" } };
    }

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();

    await beginTransaction(connection);
    try {
      // Locked until commit, so the status recorded as replaced is the one replaced.
      const rows = await executeQuery(
        connection,
        `SELECT ${QUOTE_LEDGER_COLUMNS} FROM Quotes WITH (UPDLOCK, HOLDLOCK) WHERE QuoteID = @Id`,
        [{ name: "Id", type: TYPES.Int, value: QuoteID }],
      );
      if (rows.length === 0) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: "Quote not found" } };
      }
      const quote = rows[0];
      if (quote.Status !== "completed") {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 400, jsonBody: { error: "Only completed quotes can be marked as work remaining." } };
      }
      const jobId = quote.JobID as number;
      const quoteNumber = (quote.QuoteNumber as string | null) ?? `#${QuoteID}`;

      await executeQuery(
        connection,
        "UPDATE Quotes SET Status = 'approved' WHERE QuoteID = @Id",
        [{ name: "Id", type: TYPES.Int, value: QuoteID }],
      );
      await executeQuery(
        connection,
        `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, QuoteID)
         VALUES (@JobID, @CreatedBy, @Text, 'comment', @QuoteID);`,
        [
          { name: "JobID", type: TYPES.Int, value: jobId },
          { name: "CreatedBy", type: TYPES.NVarChar, value: identity.name },
          { name: "Text", type: TYPES.NVarChar, value: `Work remaining on ${quoteNumber} — marked back in progress` },
          { name: "QuoteID", type: TYPES.Int, value: QuoteID },
        ],
      );
      await executeQuery(
        connection,
        "UPDATE Jobs SET LastModifiedDate = SYSUTCDATETIME() WHERE JobID = @JobID",
        [{ name: "JobID", type: TYPES.Int, value: jobId }],
      );

      const scope = await jobScope(connection, jobId);
      await record(connection, {
        action: "quote.uncomplete",
        actor,
        after: { status: "approved", ...quoteFacts(quote), ...amountUnchanged(quote.Amount, approvedAmount(quote)) },
        before: { status: "completed", ...contractorFacts(quote) },
        buildingId: scope.buildingId,
        jobId: scope.jobId,
        subject: { id: QuoteID, type: "quote" },
      });
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }

    const stored = await executeQuery(
      connection,
      `SELECT ${QUOTE_COLUMNS} FROM Quotes WHERE QuoteID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: QuoteID }],
    );
    return { status: 200, jsonBody: { quote: stored[0] } };
  } catch (error: any) {
    context.error("uncompleteQuote failed:", error.message);
    return errorResponse("Uncomplete quote failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/deleteQuote ────────────────────────────────────────────────────
// Body: { QuoteID }
// Refuses to delete approved or completed quotes — Jobs.ApprovedQuoteID still
// references them and a payment may have been recorded. User should reject
// (or uncomplete then unapprove) first.
//
// A deletion leaves nothing behind but its ledger row, so the row carries a
// snapshot of what was deleted, and the two commit together or not at all.

const DELETE_QUOTE_TARGET: RefusalTarget = { attempted: "quote.delete", idField: "QuoteID", subjectType: "quote" };

async function deleteQuote(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, ACTION_ROLES.manageQuotes.gate);
  if (denied) {
    await recordRoleRefusal(request, token, denied, DELETE_QUOTE_TARGET);
    return denied;
  }

  let connection;
  try {
    const body = (await request.json()) as any;
    const { QuoteID } = body ?? {};
    if (typeof QuoteID !== "number") {
      return { status: 400, jsonBody: { error: "QuoteID (number) required" } };
    }

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();

    await beginTransaction(connection);
    try {
      // Locked until commit, so the snapshot is of the quote that is deleted.
      const rows = await executeQuery(
        connection,
        `SELECT ${QUOTE_LEDGER_COLUMNS} FROM Quotes WITH (UPDLOCK, HOLDLOCK) WHERE QuoteID = @Id`,
        [{ name: "Id", type: TYPES.Int, value: QuoteID }],
      );
      if (rows.length === 0) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: "Quote not found" } };
      }
      const quote = rows[0];
      if (quote.Status === "approved" || quote.Status === "completed") {
        // A refused attempt, ledgered in a transaction of its own now that this
        // one has rolled back.
        await rollbackTransaction(connection).catch(() => {});
        const error = "Cannot delete an approved quote. Reject it first if needed.";
        await recordRefusal(
          connection,
          actor,
          { id: QuoteID, type: "quote" },
          { attempted: "quote.delete", code: "approved_quote_protected", message: error, state: { status: quote.Status as string } },
          quote.JobID as number,
        );
        return { status: 400, jsonBody: { error } };
      }

      await executeQuery(
        connection,
        `DELETE FROM Quotes WHERE QuoteID = @Id`,
        [{ name: "Id", type: TYPES.Int, value: QuoteID }],
      );

      const scope = await jobScope(connection, quote.JobID as number);
      await record(connection, {
        action: "quote.delete",
        actor,
        after: deletionAfter(quoteFacts(quote), approvedAmount(quote)),
        before: quoteSnapshot(quote),
        buildingId: scope.buildingId,
        jobId: scope.jobId,
        subject: { id: QuoteID, type: "quote" },
      });
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }

    return { status: 200, jsonBody: { deleted: true, quoteId: QuoteID } };
  } catch (error: any) {
    context.error("deleteQuote failed:", error.message);
    return errorResponse("Delete quote failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/validateQuote ──────────────────────────────────────────────────
// Body: { QuoteID } — the actor is the verified caller.
// Stamps AIValidatedAt / AIValidatedBy so the UI's "AI Generated — must be
// validated" tag clears. Idempotent: re-validating just refreshes the
// timestamp and validator.

async function validateQuote(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, ACTION_ROLES.manageQuotes.gate);
  if (denied) return denied;

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const { QuoteID } = body ?? {};
    if (typeof QuoteID !== "number") {
      return { status: 400, jsonBody: { error: "QuoteID (number) required" } };
    }

    connection = await createRequestConnection(token);

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
        { name: "ValidatedBy", type: TYPES.NVarChar, value: identity.name },
      ],
    );
    await executeQuery(
      connection,
      `INSERT INTO JobEvents
         (JobID, CreatedBy, [Text], EventType, QuoteID)
       VALUES (@JobID, @CreatedBy, @Text, 'comment', @QuoteID);`,
      [
        { name: "JobID", type: TYPES.Int, value: jobId },
        { name: "CreatedBy", type: TYPES.NVarChar, value: identity.name },
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
app.http("completeQuote", { methods: ["POST"], authLevel: "anonymous", handler: completeQuote });
app.http("uncompleteQuote", { methods: ["POST"], authLevel: "anonymous", handler: uncompleteQuote });

// ── POST /api/directorApproveQuote ───────────────────────────────────────────
// Body: { QuoteID } — the approver is the verified caller, never the body.
// Director-only: closes the gate on a quote that's been sitting in
// 'awaiting_director' since the initial approval. Sets status='approved',
// stamps DirectorApprovedAt/By, and finally mirrors ApprovedQuoteID onto Jobs.

interface DirectorApproveQuoteBody {
  QuoteID?: unknown;
}

const DIRECTOR_APPROVE_QUOTE_TARGET: RefusalTarget = {
  attempted: "quote.director_approve",
  idField: "QuoteID",
  subjectType: "quote",
};

export async function directorApproveQuote(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, ACTION_ROLES.approveQuoteAsDirector.gate);
  if (denied) {
    await recordRoleRefusal(request, token, denied, DIRECTOR_APPROVE_QUOTE_TARGET);
    return denied;
  }

  // Director-only by policy. requireRole lets admin through via the role
  // hierarchy, so re-check the literal role. Admins are deliberately
  // excluded — keep this check.
  const userRoles = await rolesForRequest(request);
  if (!userRoles.includes(AppRole.DIRECTOR)) {
    await recordRefusalForRequest(request, token, DIRECTOR_APPROVE_QUOTE_TARGET, {
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
    const body = ((await request.json().catch(() => null)) ?? {}) as DirectorApproveQuoteBody;
    const { QuoteID } = body;
    if (typeof QuoteID !== "number") {
      return { status: 400, jsonBody: { error: "QuoteID (number) required" } };
    }

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();

    // Shared with recordEmailQuoteDecision — src/quote-decisions.ts. The
    // approval and its ledger row commit or roll back together.
    await beginTransaction(connection);
    let outcome;
    try {
      outcome = await approveDirectorQuote(connection, {
        approvedBy: identity.name,
        quoteId: QuoteID,
      });
      if (!outcome.ok) {
        await rollbackTransaction(connection).catch(() => {});
        if ("code" in outcome) {
          // A job rule refused it (J3), ledgered in a transaction of its own.
          await recordRefusal(
            connection,
            actor,
            { id: QuoteID, type: "quote" },
            { attempted: "quote.director_approve", code: outcome.code, message: outcome.error, state: { status: "awaiting_director" } },
            outcome.jobId,
          );
          return { status: outcome.status, jsonBody: { code: outcome.code, error: outcome.error } };
        }
        return { status: outcome.status, jsonBody: { error: outcome.error } };
      }
      const scope = await jobScope(connection, outcome.jobId);
      await record(connection, {
        action: "quote.director_approve",
        actor,
        after: { status: "approved", ...quoteFacts(outcome.quote) },
        before: { status: "awaiting_director", ...contractorFacts(outcome.quote) },
        buildingId: scope.buildingId,
        jobId: scope.jobId,
        subject: { id: QuoteID, type: "quote" },
      });
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }

    resolveActivePlannerTasks("job", outcome.jobId, ["director_approval"]).catch(
      (err: unknown) =>
        context.warn("plannerResolve (directorApproveQuote):", err instanceof Error ? err.message : String(err)),
    );
    return { status: 200, jsonBody: { quote: outcome.quote } };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("directorApproveQuote failed:", message);
    return errorResponse("Director approve quote failed", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("directorApproveQuote", { methods: ["POST"], authLevel: "anonymous", handler: directorApproveQuote });

// ── POST /api/resendDirectorQuoteEmail ───────────────────────────────────────
// Body: { QuoteID } — the sender is the verified caller, never the body.
// Re-fires the director packet email for a quote currently awaiting director
// approval — used when the initial best-effort send failed or got missed. A
// send is ledgered once the mail has gone (see ../email/director-requests).

interface ResendDirectorQuoteEmailBody {
  QuoteID: number;
  /** @deprecated ignored — identity comes from the token */
  TriggeredBy?: string;
}

const RESEND_DIRECTOR_QUOTE_TARGET: RefusalTarget = {
  attempted: "quote.director_request_sent",
  idField: "QuoteID",
  subjectType: "quote",
};

async function resendDirectorQuoteEmail(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  // Same reasoning as resendDirectorInvoiceEmail — the workflow participants
  // who can see the banner need to be able to nudge the director themselves.
  const denied = await requireRole(request, ACTION_ROLES.resendDirectorEmail.gate);
  if (denied) {
    await recordRoleRefusal(request, token, denied, RESEND_DIRECTOR_QUOTE_TARGET);
    return denied;
  }

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as ResendDirectorQuoteEmailBody;
    const { QuoteID } = body ?? {};
    if (typeof QuoteID !== "number") {
      return { status: 400, jsonBody: { error: "QuoteID (number) required" } };
    }

    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();

    const rows = await executeQuery(
      connection,
      `SELECT JobID, Amount, ISNULL(Currency, 'AUD') AS Currency, Status, QuoteNumber, ContractorID, ContractorName
         FROM Quotes WHERE QuoteID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: QuoteID }],
    );
    if (rows.length === 0) return { status: 404, jsonBody: { error: "Quote not found" } };

    const jobId = rows[0].JobID as number;
    const amount = Number(rows[0].Amount ?? 0);
    const currency = rows[0].Currency as string;
    const status = (rows[0].Status as string) ?? "";

    if (status !== "awaiting_director") {
      return { status: 400, jsonBody: { error: "Quote is not in awaiting_director state" } };
    }

    await sendDirectorRequest({
      actor,
      amount,
      connection,
      currency,
      facts: quoteFacts(rows[0]),
      jobId,
      resend: true,
      stage: "quote",
      subjectId: QuoteID,
      triggeredBy: identity.name,
    });

    const stored = await executeQuery(
      connection,
      `SELECT ${QUOTE_COLUMNS} FROM Quotes WHERE QuoteID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: QuoteID }],
    );
    return { status: 200, jsonBody: { quote: stored[0] } };
  } catch (error: any) {
    if (error instanceof TestDataEgressError) return testRecordResponse();
    if (error instanceof DirectorRequestClaimedError) return { status: 409, jsonBody: { error: error.message } };
    context.error("resendDirectorQuoteEmail failed:", error.message);
    return errorResponse("Resend director quote email failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("resendDirectorQuoteEmail", { methods: ["POST"], authLevel: "anonymous", handler: resendDirectorQuoteEmail });
