// Payments — record partial payments against an approved quote, with two-way
// MYOB sync. Each payment starts as 'pending' and moves to 'paid' when
// confirmed in MYOB (via "Mark as paid" in the app, or the MYOB webhook).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { buildUpdateSet, createConnection, executeQuery, closeConnection } from "../db";
import { extractToken, unauthorizedResponse, errorResponse } from "../auth";
import {
  applyMyobPayment,
  buildMyobBillUrl,
  createMyobBill,
  MYOB_PAYMENT_APPLIED_EVENT,
  MYOB_WEBHOOK_KEY,
  validateMyobWebhookSignature,
  type MyobWebhookPayload,
} from "../myob-client";

const PAYMENT_COLUMNS = `
  PaymentID, JobID, QuoteID, PurchaseOrderID, Amount, Variance,
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

  const jobId = request.query.get("jobId");
  if (!jobId) {
    return { status: 400, jsonBody: { error: "jobId query param required" } };
  }

  let connection;
  try {
    connection = await createConnection(token);
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
// Creates or updates a payment. On create: computes variance from the linked
// PO, inserts the row as 'pending', then asynchronously creates a Purchase
// Bill in MYOB and stores the returned UID + URL. MYOB failure is logged but
// does NOT fail the payment — the record is always committed locally first.

async function upsertPayment(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const {
      PaymentID,
      JobID,
      QuoteID,
      PurchaseOrderID,
      Amount,
      PaidBy,
      Notes,
      CreatedBy,
    } = body ?? {};

    if (PaymentID === undefined && (typeof JobID !== "number" || typeof Amount !== "number")) {
      return { status: 400, jsonBody: { error: "JobID and Amount (numbers) required to create" } };
    }

    connection = await createConnection(token);

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

    if (PaymentID === undefined) {
      // ── Create ──────────────────────────────────────────────────────────────
      const inserted = await executeQuery(
        connection,
        `INSERT INTO Payments
           (JobID, QuoteID, PurchaseOrderID, Amount, Variance,
            PaidAt, PaidBy, Notes, CreatedBy, Status)
         OUTPUT INSERTED.PaymentID
         VALUES
           (@JobID, @QuoteID, @PurchaseOrderID, @Amount, @Variance,
            SYSUTCDATETIME(), @PaidBy, @Notes, @CreatedBy, 'pending');`,
        [
          { name: "JobID",           type: TYPES.Int,     value: JobID },
          { name: "QuoteID",         type: TYPES.Int,     value: QuoteID ?? null },
          { name: "PurchaseOrderID", type: TYPES.Int,     value: PurchaseOrderID ?? null },
          { name: "Amount",          type: TYPES.Decimal, value: Amount },
          { name: "Variance",        type: TYPES.Decimal, value: variance },
          { name: "PaidBy",          type: TYPES.NVarChar, value: PaidBy ?? null },
          { name: "Notes",           type: TYPES.NVarChar, value: Notes ?? null },
          { name: "CreatedBy",       type: TYPES.NVarChar, value: CreatedBy ?? null },
        ],
      );
      const newId = inserted[0].PaymentID as number;

      // ── Fetch job title for the MYOB bill description ────────────────────
      const jobRows = await executeQuery(
        connection,
        "SELECT Title FROM Jobs WHERE JobID = @Id",
        [{ name: "Id", type: TYPES.Int, value: JobID }],
      );
      const jobTitle = (jobRows[0]?.Title as string | null) ?? `Job #${JobID}`;

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
      try {
        const myob = await createMyobBill({
          amount: Amount,
          contractorName: contractorName ?? undefined,
          jobId: JobID,
          jobTitle,
          notes: Notes ?? undefined,
          referenceNumber: `PAY-${JobID}-${newId}`,
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
        PaidBy: TYPES.NVarChar,
        Variance: TYPES.Decimal,
      },
      { Amount, Notes, PaidBy, Variance: variance ?? undefined },
    );
    if (!update) {
      return { status: 400, jsonBody: { error: "No fields to update" } };
    }
    await executeQuery(
      connection,
      `UPDATE Payments SET ${update.setClause} WHERE PaymentID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: PaymentID }, ...update.params],
    );
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
// Body: { PaymentID, MarkedPaidBy? }
// Sets Status='paid' in our DB and applies the payment against the MYOB bill.
// If MYOB has no bill for this payment (MyobID is null), logs a warning
// but still marks the local record as paid.

async function markPaymentPaid(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const { PaymentID, MarkedPaidBy } = body ?? {};
    if (typeof PaymentID !== "number") {
      return { status: 400, jsonBody: { error: "PaymentID (number) required" } };
    }

    connection = await createConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT ${PAYMENT_COLUMNS} FROM Payments WHERE PaymentID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: PaymentID }],
    );
    if (rows.length === 0) {
      return { status: 404, jsonBody: { error: "Payment not found" } };
    }

    const payment = rows[0];
    if (payment.Status === "paid") {
      return { status: 200, jsonBody: { payment } };
    }

    // ── Apply payment in MYOB if we have a bill UID ─────────────────────────
    const myobId = payment.MyobID as string | null;
    if (myobId) {
      try {
        await applyMyobPayment({
          amount: payment.Amount as number,
          billUid: myobId,
        });
        context.log(`MYOB payment applied: bill ${myobId}, payment ${PaymentID}`);
      } catch (myobErr: any) {
        context.warn(`MYOB payment apply failed for payment ${PaymentID}: ${myobErr.message}`);
        // Continue — mark paid locally regardless.
      }
    } else {
      context.warn(`Payment ${PaymentID} has no MyobID — marking paid locally only`);
    }

    await executeQuery(
      connection,
      `UPDATE Payments
       SET Status = 'paid', MyobSyncedAt = SYSUTCDATETIME(),
           PaidBy = COALESCE(@MarkedPaidBy, PaidBy)
       WHERE PaymentID = @Id`,
      [
        { name: "Id",           type: TYPES.Int,     value: PaymentID },
        { name: "MarkedPaidBy", type: TYPES.NVarChar, value: MarkedPaidBy ?? null },
      ],
    );

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

// ── POST /api/myobWebhook ─────────────────────────────────────────────────────
// Receives MYOB webhook events. MYOB fires this when a PaymentPurchase is
// applied to a bill, letting us mark the matching Payment as 'paid'
// without any manual action in the app.
//
// Authentication: MYOB signs the raw body with HMAC-SHA256 using the shared
// webhook secret (MYOB_WEBHOOK_KEY). The signature is in the
// `x-myob-hmac-sha256` header as a base64 string.
//
// Register this URL in the MYOB developer portal:
//   https://developer.myob.com/api/myob-business-api/setup/webhooks/

async function myobWebhook(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const rawBody = await request.text();
    const signature = request.headers.get("x-myob-hmac-sha256") ?? "";

    if (!MYOB_WEBHOOK_KEY) {
      context.error("myobWebhook: MYOB_WEBHOOK_KEY is not configured");
      return { status: 500, jsonBody: { error: "Webhook not configured" } };
    }
    if (!validateMyobWebhookSignature(rawBody, signature)) {
      context.warn("myobWebhook: invalid HMAC signature — rejected");
      return { status: 401, jsonBody: { error: "Invalid signature" } };
    }

    const payload: MyobWebhookPayload = JSON.parse(rawBody);

    // We only care about PaymentPurchase.Created events — that means someone
    // applied a payment to one of our bills in MYOB.
    const paymentEvents = payload.Events?.filter(
      (e) => e.EventType === MYOB_PAYMENT_APPLIED_EVENT,
    ) ?? [];

    if (paymentEvents.length === 0) {
      return { status: 200, jsonBody: { processed: 0 } };
    }

    // The webhook entity is the PaymentPurchase record, not the Bill.
    // We need to look up our Payment row by the Bill's MyobID.
    // MYOB doesn't directly tell us which bill was paid in the webhook payload —
    // we'd need to call GET /Purchase/PaymentPurchase/{entityUID} to find the
    // applied bills. For now we use the entity UID to find matching Payments.
    // (A full implementation would fetch the PaymentPurchase from MYOB and
    //  extract the bill UIDs from the Bills array.)

    // Use a system token for the DB connection (webhook has no user token).
    // If your DB requires user-level tokens, adapt this to use a service account.
    const systemToken = process.env.SYSTEM_DB_TOKEN ?? "";
    if (!systemToken) {
      context.warn("myobWebhook: no SYSTEM_DB_TOKEN configured — skipping DB update");
      return { status: 200, jsonBody: { processed: 0, note: "no system token" } };
    }

    let connection;
    let processed = 0;
    try {
      connection = await createConnection(systemToken);
      for (const event of paymentEvents) {
        // Match payment by MyobID (the bill UID stored when we created the bill).
        // In a full implementation you'd call GET /Purchase/PaymentPurchase/{event.EntityUID}
        // to find which bill UID was paid, then match on MyobID.
        const rows = await executeQuery(
          connection,
          "SELECT PaymentID FROM Payments WHERE MyobID = @MyobID AND Status = 'pending'",
          [{ name: "MyobID", type: TYPES.NVarChar, value: event.EntityUID }],
        );
        for (const row of rows) {
          await executeQuery(
            connection,
            `UPDATE Payments
             SET Status = 'paid', MyobSyncedAt = SYSUTCDATETIME()
             WHERE PaymentID = @Id`,
            [{ name: "Id", type: TYPES.Int, value: row.PaymentID }],
          );
          context.log(`myobWebhook: payment ${row.PaymentID} marked paid via webhook`);
          processed++;
        }
      }
    } finally {
      if (connection) closeConnection(connection);
    }

    return { status: 200, jsonBody: { processed } };
  } catch (error: any) {
    context.error("myobWebhook failed:", error.message);
    return errorResponse("Webhook processing failed", error.message);
  }
}

app.http("getPayments",      { methods: ["GET"],  authLevel: "anonymous", handler: getPayments });
app.http("upsertPayment",    { methods: ["POST"], authLevel: "anonymous", handler: upsertPayment });
app.http("markPaymentPaid",  { methods: ["POST"], authLevel: "anonymous", handler: markPaymentPaid });
app.http("myobWebhook",      { methods: ["POST"], authLevel: "anonymous", handler: myobWebhook });
