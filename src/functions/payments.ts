// Payments — record a payment against an approved quote. Variance vs the
// PO's EstimatedCost is stored alongside so reports don't need to re-join.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { createConnection, executeQuery, closeConnection } from "../db";
import { extractToken, unauthorizedResponse, errorResponse } from "../auth";

const PAYMENT_COLUMNS = `
  PaymentID, JobID, QuoteID, PurchaseOrderID, Amount, Variance,
  PaidAt, PaidBy, Notes, CreatedAt, CreatedBy
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
// Body: { PaymentID?, JobID (required), QuoteID, PurchaseOrderID?, Amount,
//         PaidBy?, Notes?, CreatedBy? }
// Variance is computed server-side from the linked PO's EstimatedCost so
// clients don't duplicate that logic.

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

    // Compute variance if we have a PO reference.
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
      const inserted = await executeQuery(
        connection,
        `INSERT INTO Payments
           (JobID, QuoteID, PurchaseOrderID, Amount, Variance,
            PaidAt, PaidBy, Notes, CreatedBy)
         OUTPUT INSERTED.PaymentID
         VALUES
           (@JobID, @QuoteID, @PurchaseOrderID, @Amount, @Variance,
            SYSUTCDATETIME(), @PaidBy, @Notes, @CreatedBy);`,
        [
          { name: "JobID", type: TYPES.Int, value: JobID },
          { name: "QuoteID", type: TYPES.Int, value: QuoteID ?? null },
          { name: "PurchaseOrderID", type: TYPES.Int, value: PurchaseOrderID ?? null },
          { name: "Amount", type: TYPES.Decimal, value: Amount },
          { name: "Variance", type: TYPES.Decimal, value: variance },
          { name: "PaidBy", type: TYPES.NVarChar, value: PaidBy ?? null },
          { name: "Notes", type: TYPES.NVarChar, value: Notes ?? null },
          { name: "CreatedBy", type: TYPES.NVarChar, value: CreatedBy ?? null },
        ],
      );
      const newId = inserted[0].PaymentID as number;
      const stored = await executeQuery(
        connection,
        `SELECT ${PAYMENT_COLUMNS} FROM Payments WHERE PaymentID = @Id`,
        [{ name: "Id", type: TYPES.Int, value: newId }],
      );
      return { status: 200, jsonBody: { payment: stored[0] } };
    }

    // Update — rare but supported for correcting the amount/notes post-hoc.
    const fields: string[] = [];
    const params: { name: string; type: any; value: any }[] = [
      { name: "Id", type: TYPES.Int, value: PaymentID },
    ];
    const push = (col: string, type: any, val: unknown) => {
      fields.push(`${col} = @${col}`);
      params.push({ name: col, type, value: val ?? null });
    };
    if (Amount !== undefined) push("Amount", TYPES.Decimal, Amount);
    if (Notes !== undefined) push("Notes", TYPES.NVarChar, Notes);
    if (PaidBy !== undefined) push("PaidBy", TYPES.NVarChar, PaidBy);
    if (variance != null) push("Variance", TYPES.Decimal, variance);

    if (fields.length === 0) {
      return { status: 400, jsonBody: { error: "No fields to update" } };
    }

    await executeQuery(
      connection,
      `UPDATE Payments SET ${fields.join(", ")} WHERE PaymentID = @Id`,
      params,
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

app.http("getPayments", { methods: ["GET"], authLevel: "anonymous", handler: getPayments });
app.http("upsertPayment", { methods: ["POST"], authLevel: "anonymous", handler: upsertPayment });
