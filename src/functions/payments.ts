// Payments — record partial payments against an approved incoming invoice, with
// MYOB sync. Each payment starts as 'pending' and moves to 'paid' via "Mark as
// paid" in the app.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { Connection, TYPES } from "tedious";
import { beginTransaction, buildUpdateSet, closeConnection, commitTransaction, createRequestConnection, executeQuery, rollbackTransaction } from "../db";
import { decideAuthority, type AuthorityFacts } from "../approvalAuthority";
import { loadApprovalFacts } from "../approvalAuthority-db";
import { AppRole, extractToken, requireRole, rolesForRequest, unauthorizedResponse, errorResponse, verifiedIdentityFromRequest } from "../auth";
import { adminRefusal, holdsAdmin } from "../moneyRules";
import { isTestJob } from "../testRecords";
import { newCorrelationId, record } from "../ledger";
import { resolveLedgerActor } from "../ledger/actor";
import { jobScope, paymentFacts } from "../ledger/moneyDecisions";
import { recordRefusal, recordRoleRefusal, type RefusalTarget } from "../ledger/refusals";

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
  /** The approval facts (approvalAuthority-db.ts): the director gate is the one approval used. */
  facts: AuthorityFacts;
}): PaymentRefusal | null {
  const { amount, invoice, jobId, facts } = input;
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
  const directorRequired = decideAuthority({ amount: invoice.amount, buildingId: 0, subject: "invoice" }, facts).directorRequired;
  if (directorRequired && !invoice.directorApprovedAt) {
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

// Who the money goes to is on the invoice being paid, not on the payment.
async function loadPaidInvoice(connection: Connection, jobInvoiceId: number | null | undefined) {
  if (jobInvoiceId === null || jobInvoiceId === undefined) return undefined;
  const rows = await executeQuery(
    connection,
    "SELECT InvoiceNumber, ContractorName, SupplierInvoiceNumber FROM JobInvoices WHERE JobInvoiceID = @Id",
    [{ name: "Id", type: TYPES.Int, value: jobInvoiceId }],
  );
  return rows[0];
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

// Editing a payment isn't a ledgered decision; only an attempt to create one is
// recorded, against the invoice it would have paid.
const CREATE_PAYMENT_TARGET: RefusalTarget = {
  attempted: (body) => (body.PaymentID === undefined ? "payment.create" : null),
  idField: "JobInvoiceID",
  subjectType: "invoice",
};

async function upsertPayment(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.ACCOUNTS_APPROVAL]);
  if (denied) {
    await recordRoleRefusal(request, token, denied, CREATE_PAYMENT_TARGET);
    return denied;
  }

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  let connection;
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
      // Recording a payment is a decision (PLAN §3.12): the payment, its event
      // and its ledger row commit together or not at all. It is recorded in
      // Floorplan only (J3): a MYOB bill is its own explicit action through
      // the MYOB proposals (lane M), never bundled with this one (decision 12).
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
        // Decision 4 (J3): admin pays on test records only.
        const roles = await rolesForRequest(request);
        const adminBar = adminRefusal(roles, holdsAdmin(roles) && (await isTestJob(connection, invoice.jobId)));
        if (adminBar) {
          await rollbackTransaction(connection).catch(() => {});
          await recordRefusal(
            connection,
            ledgerActor,
            { id: create.jobInvoiceId, type: "invoice" },
            { attempted: "payment.create", code: adminBar.code, message: adminBar.message, state: { status: invoice.status } },
            invoice.jobId,
          );
          return { status: adminBar.status, jsonBody: { code: adminBar.code, error: adminBar.message } };
        }
        const refusal = paymentInvoiceRefusal({
          amount: create.amount,
          invoice,
          jobId: create.jobId,
          facts: await loadApprovalFacts(connection, null),
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

        await executeQuery(
          connection,
          `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType)
           VALUES (@JobID, @CreatedBy, @Text, 'payment_made');`,
          [
            { name: "JobID", type: TYPES.Int, value: create.jobId },
            { name: "CreatedBy", type: TYPES.NVarChar, value: identity.name },
            { name: "Text", type: TYPES.NVarChar, value: `Recorded a payment of ${formatMoney(toCents(create.amount))}` },
          ],
        );

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

      const stored = await executeQuery(
        connection,
        `SELECT ${PAYMENT_COLUMNS} FROM Payments WHERE PaymentID = @Id`,
        [{ name: "Id", type: TYPES.Int, value: newId }],
      );
      return { status: 200, jsonBody: { payment: stored[0] } };
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

    const existingRows = await executeQuery(
      connection,
      "SELECT PaymentID, JobID, JobInvoiceID, Amount, Status, MyobID FROM Payments WHERE PaymentID = @Id",
      [{ name: "Id", type: TYPES.Int, value: PaymentID }],
    );
    if (existingRows.length === 0) {
      return { status: 404, jsonBody: { error: "Payment not found" } };
    }
    const existing = existingRows[0];
    const existingInvoiceId = (existing.JobInvoiceID as number | null) ?? null;
    const amountChanges =
      typeof Amount === "number" && toCents(Amount) !== toCents(Number(existing.Amount));
    const jobChanges = JobID !== undefined && JobID !== existing.JobID;
    const invoiceChanges = JobInvoiceID !== undefined && (JobInvoiceID ?? null) !== existingInvoiceId;

    // Once MYOB has the bill, or the payment has left 'pending', what it pays
    // and how much are facts someone else has acted on.
    const isLocked = existing.MyobID != null || existing.Status !== "pending";
    if (isLocked && (amountChanges || jobChanges || invoiceChanges)) {
      return {
        status: 422,
        jsonBody: { error: "This payment has already been sent to MYOB or paid, so its job, invoice and amount can't be changed." },
      };
    }

    const updateParams = update.params.map((p) =>
      p.type === TYPES.Decimal ? { ...p, options: MONEY_OPTIONS } : p,
    );
    const updateSql = `UPDATE Payments SET ${update.setClause} WHERE PaymentID = @Id`;
    const updateArgs = [{ name: "Id", type: TYPES.Int, value: PaymentID }, ...updateParams];

    if (amountChanges && existingInvoiceId != null) {
      // Raising the amount of a pending payment must not slip past the cap
      // checked on create.
      await beginTransaction(connection);
      try {
        const invoice = await loadInvoiceForPayment(connection, existingInvoiceId, PaymentID);
        const refusal = invoice
          ? paymentInvoiceError({
              amount: Amount as number,
              invoice,
              jobId: existing.JobID as number,
              facts: await loadApprovalFacts(connection, null),
            })
          : "The invoice this payment was recorded against no longer exists.";
        if (refusal) {
          await rollbackTransaction(connection).catch(() => {});
          return { status: 422, jsonBody: { error: refusal } };
        }
        await executeQuery(connection, updateSql, updateArgs);
        await commitTransaction(connection);
      } catch (err) {
        await rollbackTransaction(connection).catch(() => {});
        throw err;
      }
    } else {
      await executeQuery(connection, updateSql, updateArgs);
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
// Sets Status='paid' in Floorplan. Nothing is sent to MYOB (J3): a MYOB write
// is its own explicit action through lane M's proposals (decision 12), so a
// payment is never marked paid on the strength of, or despite, a MYOB call.
//
// Marking a payment paid is a decision (PLAN §3.12): it re-checks the invoice
// it pays (still approved, director-approved where the gate needs it, the
// unpaid balance covers it), and the status and its ledger row commit
// together or not at all.

interface MarkPaymentPaidBody {
  PaymentID?: number;
  /** @deprecated ignored — identity comes from the token */
  MarkedPaidBy?: string;
}

const MARK_PAID_TARGET: RefusalTarget = {
  attempted: "payment.mark_paid",
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

    await beginTransaction(connection);
    let payment;
    try {
      // Locked until commit, so two clicks on "Mark as paid" can't both get
      // past the paid check.
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

      const refusal = await markPaidRefusal(connection, request, payment, PaymentID);
      if (refusal) {
        // A refused attempt, ledgered in a transaction of its own now that this
        // one has rolled back.
        await rollbackTransaction(connection).catch(() => {});
        await recordRefusal(
          connection,
          ledgerActor,
          { id: PaymentID, type: "payment" },
          { attempted: "payment.mark_paid", code: refusal.code, message: refusal.message, state: { status: payment.Status } },
          (payment.JobID as number | null | undefined) ?? null,
        );
        return { status: refusal.status, jsonBody: { code: refusal.code, error: refusal.message } };
      }

      await executeQuery(
        connection,
        `UPDATE Payments
         SET Status = 'paid', PaidAt = SYSUTCDATETIME(),
             PaidBy = @MarkedPaidBy
         WHERE PaymentID = @Id`,
        [
          { name: "Id",           type: TYPES.Int,     value: PaymentID },
          { name: "MarkedPaidBy", type: TYPES.NVarChar, value: identity.name },
        ],
      );

      const scope = await jobScope(connection, payment.JobID as number | null | undefined);
      await record(connection, {
        action: "payment.mark_paid",
        actor: ledgerActor,
        after: { status: "paid", ...paymentFacts(payment, await loadPaidInvoice(connection, payment.JobInvoiceID)) },
        before: { status: (payment.Status as string | null) ?? null },
        buildingId: scope.buildingId,
        jobId: scope.jobId,
        subject: { id: PaymentID, type: "payment" },
      });
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }

    const updated = await executeQuery(
      connection,
      `SELECT ${PAYMENT_COLUMNS} FROM Payments WHERE PaymentID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: PaymentID }],
    );
    return { status: 200, jsonBody: { payment: updated[0] } };
  } catch (error: any) {
    context.error("markPaymentPaid failed:", error.message);
    return errorResponse("Mark payment paid failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

/**
 * Why this payment can't be marked paid now, or null (J3): admin only on test
 * records (decision 4); it must pay an invoice; and that invoice, as it stands
 * now, must still allow this payment (approved, director-approved where the
 * gate needs it, the unpaid balance net of the other payments covers it).
 */
async function markPaidRefusal(
  connection: Connection,
  request: HttpRequest,
  payment: Record<string, unknown>,
  paymentId: number,
): Promise<{ code: string; message: string; status: number } | null> {
  const jobId = payment.JobID as number;
  const roles = await rolesForRequest(request);
  const adminBar = adminRefusal(roles, holdsAdmin(roles) && (await isTestJob(connection, jobId)));
  if (adminBar) return adminBar;
  const invoiceId = (payment.JobInvoiceID as number | null | undefined) ?? null;
  if (invoiceId === null) {
    return { code: "no_invoice", message: "This payment isn't recorded against an invoice, so it can't be checked and marked paid.", status: 422 };
  }
  const invoice = await loadInvoiceForPayment(connection, invoiceId, paymentId);
  if (!invoice) return { code: "no_invoice", message: "The invoice this payment was recorded against no longer exists.", status: 422 };
  const refusal = paymentInvoiceRefusal({
    amount: Number(payment.Amount),
    facts: await loadApprovalFacts(connection, null),
    invoice,
    jobId,
  });
  return refusal ? { ...refusal, status: 422 } : null;
}

// MYOB's Business API has no webhooks, so nothing pushes "paid" to us. Paid
// status will come from a polling reconciler of GET /Purchase/SupplierPayment
// (Lines[].Purchase.UID = the bill UID), tracked in launch plan WP55.

app.http("getPayments",      { methods: ["GET"],  authLevel: "anonymous", handler: getPayments });
app.http("upsertPayment",    { methods: ["POST"], authLevel: "anonymous", handler: upsertPayment });
app.http("markPaymentPaid",  { methods: ["POST"], authLevel: "anonymous", handler: markPaymentPaid });
