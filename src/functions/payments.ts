// Payments — record partial payments against an approved incoming invoice, with
// MYOB sync. Each payment starts as 'pending' and moves to 'paid' via "Mark as
// paid" in the app.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { Connection, TYPES } from "tedious";
import { beginTransaction, buildUpdateSet, closeConnection, commitTransaction, createRequestConnection, executeQuery, rollbackTransaction } from "../db";
import { getCachedApprovalLimits } from "../approval-limits-db";
import { requiresDirectorApproval, type ApprovalLimit } from "./invoices";
import { AppRole, extractToken, requireRole, rolesForRequest, unauthorizedResponse, errorResponse, verifiedIdentityFromRequest } from "../auth";
import { MyobWritesDisabledError, userActor } from "../myob-api-log";
import { applyMyobPayment, createMyobBill } from "../myob-client";
import { newCorrelationId, record } from "../ledger";
import { resolveLedgerActor } from "../ledger/actor";
import { contractorFacts, jobScope, paymentEdit, paymentFacts, withContractorId } from "../ledger/moneyDecisions";
import { recordRefusal, recordRoleRefusal, type RefusalTarget } from "../ledger/refusals";
import type { LedgerActor } from "../ledger/types";

const PAYMENT_COLUMNS = `
  PaymentID, JobID, JobInvoiceID, QuoteID, PurchaseOrderID, Amount, Variance,
  PaidAt, PaidBy, Notes, CreatedAt, CreatedBy,
  Status, MyobID, MyobURL, MyobSyncedAt
`;

// ── GET /api/getPayments?jobId=N ─────────────────────────────────────────────

async function getPayments(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.DIRECTOR]);
  if (denied) return denied;

  const jobId = request.query.get("jobId");
  if (!jobId) {
    return { status: 400, jsonBody: { error: "jobId query param required" } };
  }

  let connection;
  try {
    connection = await createRequestConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT ${PAYMENT_COLUMNS} FROM Payments WHERE JobID = @JobID ORDER BY CreatedAt DESC`,
      [{ name: "JobID", type: TYPES.Int, value: Number(jobId) }],
    );
    return { status: 200, jsonBody: { count: rows.length, payments: rows } };
  } catch (error: any) {
    context.error("getPayments failed:", error.message);
    return errorResponse("Failed to fetch payments", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/upsertPayment ──────────────────────────────────────────────────
// The actor (CreatedBy / PaidBy) is the verified caller, never the body.
// Creates or updates a payment. A payment is always made against one approved
// incoming invoice (JobInvoiceID): the invoice must be fully approved, belong
// to the job, and have enough left unpaid to cover the amount. On create:
// computes variance from the linked PO, inserts the row as 'pending', then
// creates a Purchase Bill in MYOB and stores the returned UID + URL. MYOB
// failure is logged but does NOT fail the payment — the record is always
// committed locally first.

interface UpsertPaymentBody {
  PaymentID?: number;
  JobID?: number;
  JobInvoiceID?: number | null;
  QuoteID?: number;
  PurchaseOrderID?: number;
  Amount?: number;
  Notes?: string;
  /** @deprecated ignored — identity comes from the token */
  PaidBy?: string;
  /** @deprecated ignored — identity comes from the token */
  CreatedBy?: string;
}

// Payments.Amount is DECIMAL(18,2). tedious declares Decimal params at scale 0
// unless told otherwise, which rounds cents away before the value reaches SQL.
const MONEY_OPTIONS = { precision: 18, scale: 2 };

// Non-fatal: the payment is committed locally either way.
const MYOB_WRITES_OFF_ON_CREATE =
  "MYOB sync is switched off, so this payment was saved in Floorplan only — no bill was created in MYOB.";
const MYOB_WRITES_OFF_ON_PAID =
  "MYOB sync is switched off, so this payment was marked paid in Floorplan only — nothing was sent to MYOB.";

const toCents = (amount: number): number => Math.round(amount * 100);
const formatMoney = (cents: number): string =>
  `$${(cents / 100).toLocaleString("en-AU", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;

export interface PaymentInvoiceFacts {
  amount: number | null;
  directorApprovedAt: Date | null;
  direction: string;
  jobId: number;
  /** Sum of the invoice's other pending + paid payments. */
  paidSoFar: number;
  status: string;
}

export interface PaymentRefusal {
  /** Short reason code, recorded in the ledger when the refusal is a control on paying money. */
  code: string;
  message: string;
}

/**
 * Why a payment of `amount` against this invoice must be refused, or null.
 *
 * 'director_approved' counts as approved: approving as director moves the
 * invoice off 'approved' (it never holds 'approved' and a DirectorApprovedAt
 * together), so an over-limit invoice could otherwise never be paid.
 */
export function paymentInvoiceRefusal(input: {
  amount: number;
  invoice: PaymentInvoiceFacts;
  jobId: number;
  limits: ApprovalLimit[];
}): PaymentRefusal | null {
  const { amount, invoice, jobId, limits } = input;
  if (invoice.jobId !== jobId) return { code: "different_job", message: "That invoice belongs to a different job." };
  if (invoice.direction !== "incoming") {
    return { code: "not_incoming", message: "Payments can only be recorded against incoming (contractor) invoices." };
  }
  if (invoice.status !== "approved" && invoice.status !== "director_approved") {
    return {
      code: "invoice_not_approved",
      message: `The invoice has to be approved before it can be paid (it is currently ${invoice.status}).`,
    };
  }
  if (invoice.amount == null || invoice.amount <= 0) {
    return { code: "no_invoice_amount", message: "The invoice has no amount recorded, so it can't be paid." };
  }
  if (requiresDirectorApproval(invoice.amount, limits) && !invoice.directorApprovedAt) {
    return {
      code: "director_approval_required",
      message: "This invoice is over the approval limit and needs director approval before it can be paid.",
    };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { code: "invalid_amount", message: "The payment amount must be greater than zero." };
  }
  const remainingCents = toCents(invoice.amount) - toCents(invoice.paidSoFar);
  if (toCents(amount) > remainingCents) {
    return {
      code: "exceeds_unpaid_balance",
      message: `A payment of ${formatMoney(toCents(amount))} is more than the ${formatMoney(Math.max(remainingCents, 0))} still unpaid on this invoice.`,
    };
  }
  return null;
}

export function paymentInvoiceError(input: Parameters<typeof paymentInvoiceRefusal>[0]): string | null {
  return paymentInvoiceRefusal(input)?.message ?? null;
}

// The refusals that are controls on paying money: the approval chain and the
// invoice's balance. These are ledgered as refused attempts; the rest are bad
// input (the wrong job, a zero amount) and are not.
const RECORDED_PAYMENT_REFUSALS: ReadonlySet<string> = new Set([
  "director_approval_required",
  "exceeds_unpaid_balance",
  "invoice_not_approved",
]);

// Who the money goes to is on the invoice being paid, not on the payment, and
// so is the amount its approval covered.
async function loadPaidInvoice(connection: Connection, jobInvoiceId: number | null | undefined) {
  if (jobInvoiceId === null || jobInvoiceId === undefined) return undefined;
  const rows = await executeQuery(
    connection,
    "SELECT InvoiceNumber, ContractorName, SupplierInvoiceNumber, Amount FROM JobInvoices WHERE JobInvoiceID = @Id",
    [{ name: "Id", type: TYPES.Int, value: jobInvoiceId }],
  );
  return rows[0] ? withContractorId(connection, rows[0]) : undefined;
}

// Locks the invoice row for the surrounding transaction so two concurrent
// payments can't both pass the "still unpaid" check. Statuses counted here are
// the ones Payments actually uses ('pending', 'paid' — migration 018); add any
// void/cancelled status to neither side of this list.
async function loadInvoiceForPayment(
  connection: Connection,
  jobInvoiceId: number,
  excludePaymentId: number,
): Promise<PaymentInvoiceFacts | null> {
  const rows = await executeQuery(
    connection,
    `SELECT i.JobID, i.Direction, i.Status, i.Amount, i.DirectorApprovedAt,
            ISNULL((SELECT SUM(p.Amount) FROM Payments p
                     WHERE p.JobInvoiceID = i.JobInvoiceID
                       AND p.Status IN ('pending', 'paid')
                       AND p.PaymentID <> @ExcludePaymentID), 0) AS PaidSoFar
       FROM JobInvoices i WITH (UPDLOCK, HOLDLOCK)
      WHERE i.JobInvoiceID = @JobInvoiceID`,
    [
      { name: "JobInvoiceID", type: TYPES.Int, value: jobInvoiceId },
      { name: "ExcludePaymentID", type: TYPES.Int, value: excludePaymentId },
    ],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    amount: row.Amount == null ? null : Number(row.Amount),
    directorApprovedAt: (row.DirectorApprovedAt as Date | null) ?? null,
    direction: (row.Direction as string | null) ?? "incoming",
    jobId: row.JobID as number,
    paidSoFar: Number(row.PaidSoFar ?? 0),
    status: (row.Status as string | null) ?? "pending",
  };
}

interface CreatePaymentInput {
  amount: number;
  jobId: number;
  jobInvoiceId: number;
}

function parseCreateInput(
  body: UpsertPaymentBody,
): { ok: true; value: CreatePaymentInput } | { ok: false; response: HttpResponseInit } {
  const { Amount, JobID, JobInvoiceID } = body;
  if (typeof JobID !== "number" || typeof Amount !== "number") {
    return { ok: false, response: { status: 400, jsonBody: { error: "JobID and Amount (numbers) required to create" } } };
  }
  if (typeof JobInvoiceID !== "number") {
    return {
      ok: false,
      response: { status: 400, jsonBody: { error: "JobInvoiceID (number) required — a payment is made against an approved invoice" } },
    };
  }
  if (!Number.isFinite(Amount) || Amount <= 0) {
    return { ok: false, response: { status: 422, jsonBody: { error: "The payment amount must be greater than zero." } } };
  }
  return { ok: true, value: { amount: Amount, jobId: JobID, jobInvoiceId: JobInvoiceID } };
}

// What a refused request was trying to do. Creating a payment is recorded
// against the invoice it would have paid; changing the amount of one against
// the payment. Any other edit (notes, say) isn't a ledgered decision.
const PAYMENT_TARGETS: RefusalTarget[] = [
  {
    attempted: (body) => (body.PaymentID === undefined ? "payment.create" : null),
    idField: "JobInvoiceID",
    subjectType: "invoice",
  },
  {
    attempted: (body) => (body.PaymentID !== undefined && typeof body.Amount === "number" ? "payment.amount_change" : null),
    idField: "PaymentID",
    subjectType: "payment",
  },
];

// A refused attempt to change a payment's amount, ledgered in a transaction of
// its own once the edit's has rolled back. `state` is how the payment stood.
async function refuseAmountChange(
  connection: Connection,
  editor: LedgerActor | null,
  payment: { id: number; jobId: number },
  refusal: { code: string; message: string; state: Record<string, unknown> },
): Promise<void> {
  await rollbackTransaction(connection).catch(() => {});
  if (!editor) return;
  await recordRefusal(
    connection,
    editor,
    { id: payment.id, type: "payment" },
    { attempted: "payment.amount_change", code: refusal.code, message: refusal.message, state: refusal.state },
    payment.jobId,
  );
}

async function upsertPayment(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.ACCOUNTS_APPROVAL]);
  if (denied) {
    await recordRoleRefusal(request, token, denied, PAYMENT_TARGETS);
    return denied;
  }

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const actor = userActor(identity, await rolesForRequest(request).catch(() => []));

  let connection: Connection | undefined;
  try {
    const body = ((await request.json()) ?? {}) as UpsertPaymentBody;
    const { PaymentID, JobID, JobInvoiceID, QuoteID, PurchaseOrderID, Amount, Notes } = body;

    let create: CreatePaymentInput | undefined;
    if (PaymentID === undefined) {
      const parsed = parseCreateInput(body);
      if (!parsed.ok) return parsed.response;
      create = parsed.value;
    }

    connection = await createRequestConnection(token);

    // Compute variance from the linked PO.
    let variance: number | null = null;
    if (PurchaseOrderID) {
      const poRows = await executeQuery(
        connection,
        "SELECT EstimatedCost FROM PurchaseOrders WHERE PurchaseOrderID = @Id",
        [{ name: "Id", type: TYPES.Int, value: PurchaseOrderID }],
      );
      const estimate = poRows[0]?.EstimatedCost as number | null | undefined;
      if (typeof Amount === "number" && estimate != null) {
        variance = Amount - estimate;
      }
    }

    if (create) {
      // ── Create ──────────────────────────────────────────────────────────────
      // Recording a payment is a decision (PLAN §3.12): the payment and its
      // ledger row commit together or not at all, and only then is MYOB asked
      // for the bill (as it always was). One correlation id goes to the ledger
      // row and to that MYOB call, so MyobApiLog leads back to the decision.
      const ledgerActor = await resolveLedgerActor(request, connection);
      if (!ledgerActor) return unauthorizedResponse();
      const correlationId = newCorrelationId();

      let newId: number;
      await beginTransaction(connection);
      try {
        const invoice = await loadInvoiceForPayment(connection, create.jobInvoiceId, 0);
        if (!invoice) {
          await rollbackTransaction(connection).catch(() => {});
          return { status: 404, jsonBody: { error: "Invoice not found." } };
        }
        const refusal = paymentInvoiceRefusal({
          amount: create.amount,
          invoice,
          jobId: create.jobId,
          limits: await getCachedApprovalLimits(connection),
        });
        if (refusal) {
          await rollbackTransaction(connection).catch(() => {});
          if (RECORDED_PAYMENT_REFUSALS.has(refusal.code)) {
            // A refused attempt, ledgered in a transaction of its own now that
            // this one has rolled back.
            await recordRefusal(
              connection,
              ledgerActor,
              { id: create.jobInvoiceId, type: "invoice" },
              { attempted: "payment.create", code: refusal.code, message: refusal.message, state: { status: invoice.status } },
              invoice.jobId,
            );
          }
          return { status: 422, jsonBody: { error: refusal.message } };
        }

        const inserted = await executeQuery(
          connection,
          `INSERT INTO Payments
             (JobID, JobInvoiceID, QuoteID, PurchaseOrderID, Amount, Variance,
              PaidAt, PaidBy, Notes, CreatedBy, Status)
           OUTPUT INSERTED.PaymentID
           VALUES
             (@JobID, @JobInvoiceID, @QuoteID, @PurchaseOrderID, @Amount, @Variance,
              SYSUTCDATETIME(), @PaidBy, @Notes, @CreatedBy, 'pending');`,
          [
            { name: "JobID",           type: TYPES.Int,     value: create.jobId },
            { name: "JobInvoiceID",    type: TYPES.Int,     value: create.jobInvoiceId },
            { name: "QuoteID",         type: TYPES.Int,     value: QuoteID ?? null },
            { name: "PurchaseOrderID", type: TYPES.Int,     value: PurchaseOrderID ?? null },
            { name: "Amount",          type: TYPES.Decimal, value: create.amount, options: MONEY_OPTIONS },
            { name: "Variance",        type: TYPES.Decimal, value: variance,      options: MONEY_OPTIONS },
            { name: "PaidBy",          type: TYPES.NVarChar, value: identity.name },
            { name: "Notes",           type: TYPES.NVarChar, value: Notes ?? null },
            { name: "CreatedBy",       type: TYPES.NVarChar, value: identity.name },
          ],
        );
        newId = inserted[0].PaymentID as number;

        const scope = await jobScope(connection, create.jobId);
        await record(connection, {
          action: "payment.create",
          actor: ledgerActor,
          after: {
            status: "pending",
            ...paymentFacts(
              {
                Amount: create.amount,
                JobInvoiceID: create.jobInvoiceId,
                MyobID: null,
                PurchaseOrderID: PurchaseOrderID ?? null,
                QuoteID: QuoteID ?? null,
              },
              await loadPaidInvoice(connection, create.jobInvoiceId),
            ),
          },
          buildingId: scope.buildingId,
          correlationId,
          jobId: scope.jobId,
          subject: { id: newId, type: "payment" },
        });
        await commitTransaction(connection);
      } catch (err) {
        await rollbackTransaction(connection).catch(() => {});
        throw err;
      }

      // ── Fetch job title for the MYOB bill description ────────────────────
      const jobRows = await executeQuery(
        connection,
        "SELECT Title FROM Jobs WHERE JobID = @Id",
        [{ name: "Id", type: TYPES.Int, value: create.jobId }],
      );
      const jobTitle = (jobRows[0]?.Title as string | null) ?? `Job #${create.jobId}`;

      // ── Contractor name from the linked quote (optional) ─────────────────
      let contractorName: string | null = null;
      if (QuoteID) {
        const quoteRows = await executeQuery(
          connection,
          "SELECT ContractorName FROM Quotes WHERE QuoteID = @Id",
          [{ name: "Id", type: TYPES.Int, value: QuoteID }],
        );
        contractorName = (quoteRows[0]?.ContractorName as string | null) ?? null;
      }

      // ── Create MYOB Purchase Bill (fire-and-forget on error) ────────────
      let myobWarning: string | undefined;
      try {
        const myob = await createMyobBill({
          actor,
          amount: create.amount,
          contractorName: contractorName ?? undefined,
          correlationId,
          jobId: create.jobId,
          jobTitle,
          notes: Notes ?? undefined,
          referenceNumber: `PAY-${create.jobId}-${newId}`,
          sqlToken: token,
        });
        await executeQuery(
          connection,
          `UPDATE Payments
           SET MyobID = @MyobID, MyobURL = @MyobURL, MyobSyncedAt = SYSUTCDATETIME()
           WHERE PaymentID = @Id`,
          [
            { name: "MyobID",  type: TYPES.NVarChar, value: myob.uid },
            { name: "MyobURL", type: TYPES.NVarChar, value: myob.url },
            { name: "Id",      type: TYPES.Int,      value: newId },
          ],
        );
        context.log(`MYOB bill created: ${myob.uid} for payment ${newId}`);
      } catch (myobErr: any) {
        // MYOB failure must not block the payment — log and continue.
        context.warn(`MYOB bill creation failed for payment ${newId}: ${myobErr.message}`);
        if (myobErr instanceof MyobWritesDisabledError) myobWarning = MYOB_WRITES_OFF_ON_CREATE;
      }

      const stored = await executeQuery(
        connection,
        `SELECT ${PAYMENT_COLUMNS} FROM Payments WHERE PaymentID = @Id`,
        [{ name: "Id", type: TYPES.Int, value: newId }],
      );
      return { status: 200, jsonBody: { payment: stored[0], ...(myobWarning ? { myobWarning } : {}) } };
    }

    // ── Update ───────────────────────────────────────────────────────────────
    if (typeof PaymentID !== "number") {
      return { status: 400, jsonBody: { error: "PaymentID must be a number" } };
    }
    const update = buildUpdateSet(
      {
        Amount: TYPES.Decimal,
        Notes: TYPES.NVarChar,
        Variance: TYPES.Decimal,
      },
      { Amount, Notes, Variance: variance ?? undefined },
    );
    if (!update) {
      return { status: 400, jsonBody: { error: "No fields to update" } };
    }

    // An edit that carries an amount can change what is paid, which is a
    // decision (PLAN §3.12): the payment is read under lock, and the change and
    // its ledger row commit together or not at all. Only those edits look up who
    // is editing.
    let editor: LedgerActor | null = null;
    if (typeof Amount === "number") {
      editor = await resolveLedgerActor(request, connection);
      if (!editor) return unauthorizedResponse();
    }

    await beginTransaction(connection);
    try {
      const existingRows = await executeQuery(
        connection,
        "SELECT PaymentID, JobID, JobInvoiceID, Amount, Status, MyobID FROM Payments WITH (UPDLOCK, HOLDLOCK) WHERE PaymentID = @Id",
        [{ name: "Id", type: TYPES.Int, value: PaymentID }],
      );
      if (existingRows.length === 0) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: "Payment not found" } };
      }
      const existing = existingRows[0];
      const existingInvoiceId = (existing.JobInvoiceID as number | null) ?? null;
      const amountChanges =
        typeof Amount === "number" && toCents(Amount) !== toCents(Number(existing.Amount));
      const jobChanges = JobID !== undefined && JobID !== existing.JobID;
      const invoiceChanges = JobInvoiceID !== undefined && (JobInvoiceID ?? null) !== existingInvoiceId;

      const payment = { id: PaymentID, jobId: existing.JobID as number };
      // What a refused attempt shows: the payment as it stood (its MYOB bill,
      // if it has one, included) and the amount that was asked for.
      const refusedState = amountChanges
        ? {
            amount: Number(existing.Amount),
            jobInvoiceId: existingInvoiceId,
            myobBillUid: typeof existing.MyobID === "string" ? existing.MyobID : null,
            requestedAmount: Amount,
            status: String(existing.Status),
          }
        : {};

      // Once MYOB has the bill, or the payment has left 'pending', what it pays
      // and how much are facts someone else has acted on.
      const isLocked = existing.MyobID != null || existing.Status !== "pending";
      if (isLocked && (amountChanges || jobChanges || invoiceChanges)) {
        const error = "This payment has already been sent to MYOB or paid, so its job, invoice and amount can't be changed.";
        if (amountChanges) {
          await refuseAmountChange(connection, editor, payment, {
            code: "payment_locked",
            message: error,
            state: refusedState,
          });
        } else {
          await rollbackTransaction(connection).catch(() => {});
        }
        return { status: 422, jsonBody: { error } };
      }

      const updateParams = update.params.map((p) =>
        p.type === TYPES.Decimal ? { ...p, options: MONEY_OPTIONS } : p,
      );
      const updateSql = `UPDATE Payments SET ${update.setClause} WHERE PaymentID = @Id`;
      const updateArgs = [{ name: "Id", type: TYPES.Int, value: PaymentID }, ...updateParams];

      if (amountChanges && existingInvoiceId != null) {
        // Raising the amount of a pending payment must not slip past the cap
        // checked on create.
        const invoice = await loadInvoiceForPayment(connection, existingInvoiceId, PaymentID);
        const refusal: PaymentRefusal | null = invoice
          ? paymentInvoiceRefusal({
              amount: Amount as number,
              invoice,
              jobId: existing.JobID as number,
              limits: await getCachedApprovalLimits(connection),
            })
          : { code: "invoice_missing", message: "The invoice this payment was recorded against no longer exists." };
        if (refusal) {
          if (RECORDED_PAYMENT_REFUSALS.has(refusal.code)) {
            await refuseAmountChange(connection, editor, payment, {
              code: refusal.code,
              message: refusal.message,
              state: { ...refusedState, invoiceStatus: invoice?.status ?? null },
            });
          } else {
            await rollbackTransaction(connection).catch(() => {});
          }
          return { status: 422, jsonBody: { error: refusal.message } };
        }
      }
      await executeQuery(connection, updateSql, updateArgs);

      if (amountChanges) {
        // Only an edit that carries an amount can get here, and those looked up
        // who is editing above.
        if (!editor) throw new Error("A payment amount was changed without a ledger actor");
        const scope = await jobScope(connection, existing.JobID as number);
        const edit = paymentEdit(existing, Amount as number, await loadPaidInvoice(connection, existingInvoiceId));
        await record(connection, {
          action: "payment.amount_change",
          actor: editor,
          after: edit.after,
          before: edit.before,
          buildingId: scope.buildingId,
          jobId: scope.jobId,
          subject: { id: PaymentID, type: "payment" },
        });
      }
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }

    const stored = await executeQuery(
      connection,
      `SELECT ${PAYMENT_COLUMNS} FROM Payments WHERE PaymentID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: PaymentID }],
    );
    if (stored.length === 0) {
      return { status: 404, jsonBody: { error: "Payment not found" } };
    }
    return { status: 200, jsonBody: { payment: stored[0] } };
  } catch (error: any) {
    context.error("upsertPayment failed:", error.message);
    return errorResponse("Upsert payment failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/markPaymentPaid ─────────────────────────────────────────────────
// Body: { PaymentID } — PaidBy is the verified caller, never the body.
// Sets Status='paid' in our DB and applies the payment against the MYOB bill.
// If MYOB has no bill for this payment (MyobID is null), logs a warning
// but still marks the local record as paid.
//
// Marking a payment paid is a decision (PLAN §3.12): the status and its ledger
// row commit together or not at all. Only then is MYOB told, so a failed ledger
// write can't leave MYOB holding a payment that Floorplan still shows as
// pending (and that a retry would apply a second time). One correlation id
// goes to both the ledger row and the MYOB call, so MyobApiLog leads back to
// the decision. What MYOB is sent, and the MYOB_WRITES_ENABLED switch, are
// unchanged; MYOB failing is still not fatal.

interface MarkPaymentPaidBody {
  PaymentID?: number;
  /** @deprecated ignored — identity comes from the token */
  MarkedPaidBy?: string;
}

const MARK_PAID_TARGET: RefusalTarget = {
  attempted: "payment.myob_applied",
  idField: "PaymentID",
  subjectType: "payment",
};

async function markPaymentPaid(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.ACCOUNTS_APPROVAL]);
  if (denied) {
    await recordRoleRefusal(request, token, denied, MARK_PAID_TARGET);
    return denied;
  }

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const actor = userActor(identity, await rolesForRequest(request).catch(() => []));

  let connection;
  try {
    const body = (await request.json()) as MarkPaymentPaidBody;
    const { PaymentID } = body ?? {};
    if (typeof PaymentID !== "number") {
      return { status: 400, jsonBody: { error: "PaymentID (number) required" } };
    }

    connection = await createRequestConnection(token);
    const ledgerActor = await resolveLedgerActor(request, connection);
    if (!ledgerActor) return unauthorizedResponse();

    const correlationId = newCorrelationId();

    await beginTransaction(connection);
    let payment;
    try {
      // Locked until commit, so two clicks on "Mark as paid" can't both get
      // past the paid check and apply the payment in MYOB twice.
      const rows = await executeQuery(
        connection,
        `SELECT ${PAYMENT_COLUMNS} FROM Payments WITH (UPDLOCK, HOLDLOCK) WHERE PaymentID = @Id`,
        [{ name: "Id", type: TYPES.Int, value: PaymentID }],
      );
      if (rows.length === 0) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: "Payment not found" } };
      }

      payment = rows[0];
      if (payment.Status === "paid") {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 200, jsonBody: { payment } };
      }

      await executeQuery(
        connection,
        `UPDATE Payments
         SET Status = 'paid', MyobSyncedAt = SYSUTCDATETIME(),
             PaidBy = @MarkedPaidBy
         WHERE PaymentID = @Id`,
        [
          { name: "Id",           type: TYPES.Int,     value: PaymentID },
          { name: "MarkedPaidBy", type: TYPES.NVarChar, value: identity.name },
        ],
      );

      const scope = await jobScope(connection, payment.JobID as number | null | undefined);
      const invoice = await loadPaidInvoice(connection, payment.JobInvoiceID);
      await record(connection, {
        action: "payment.myob_applied",
        actor: ledgerActor,
        after: { status: "paid", ...paymentFacts(payment, invoice) },
        before: { status: (payment.Status as string | null) ?? null, ...contractorFacts(invoice ?? {}) },
        buildingId: scope.buildingId,
        correlationId,
        jobId: scope.jobId,
        subject: { id: PaymentID, type: "payment" },
      });
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }

    // ── Apply payment in MYOB if we have a bill UID ─────────────────────────
    const myobId = payment.MyobID as string | null;
    let myobWarning: string | undefined;
    if (myobId) {
      try {
        await applyMyobPayment({
          actor,
          amount: payment.Amount as number,
          billUid: myobId,
          correlationId,
          sqlToken: token,
        });
        context.log(`MYOB payment applied: bill ${myobId}, payment ${PaymentID}`);
      } catch (myobErr: any) {
        context.warn(`MYOB payment apply failed for payment ${PaymentID}: ${myobErr.message}`);
        if (myobErr instanceof MyobWritesDisabledError) myobWarning = MYOB_WRITES_OFF_ON_PAID;
        // Continue — the payment is marked paid locally regardless.
      }
    } else {
      context.warn(`Payment ${PaymentID} has no MyobID — marking paid locally only`);
    }

    const updated = await executeQuery(
      connection,
      `SELECT ${PAYMENT_COLUMNS} FROM Payments WHERE PaymentID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: PaymentID }],
    );
    return { status: 200, jsonBody: { payment: updated[0], ...(myobWarning ? { myobWarning } : {}) } };
  } catch (error: any) {
    context.error("markPaymentPaid failed:", error.message);
    return errorResponse("Mark payment paid failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// MYOB's Business API has no webhooks, so nothing pushes "paid" to us. Paid
// status will come from a polling reconciler of GET /Purchase/SupplierPayment
// (Lines[].Purchase.UID = the bill UID), tracked in launch plan WP55.

app.http("getPayments",      { methods: ["GET"],  authLevel: "anonymous", handler: getPayments });
app.http("upsertPayment",    { methods: ["POST"], authLevel: "anonymous", handler: upsertPayment });
app.http("markPaymentPaid",  { methods: ["POST"], authLevel: "anonymous", handler: markPaymentPaid });
