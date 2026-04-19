// Purchase Orders — CRUD + "send" stub. The send endpoint persists the
// outgoing email metadata and flips SentAt/SentBy; actual PDF generation
// and Microsoft Graph sendMail are follow-on work that plug into the same
// endpoint without schema changes.

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
import { resolveRecipient } from "../email-recipient";
import { renderPurchaseOrderPDF } from "../pdf/purchase-order-pdf";
import { defaultPOEmail } from "../pdf/default-po-email";
import {
  deleteBlob,
  generateReadSasUrl,
  uploadPurchaseOrderPdf,
} from "../blob-storage";
import {
  INTERNAL_ACRONYM,
  ensureContractorAcronym,
} from "../contractor-acronym-db";
import { formatDocNumber } from "../doc-number";

const PO_COLUMNS = `
  PurchaseOrderID, JobID, PONumber, Seq, ContractorID, ContractorName,
  Scope, EstimatedCost, CostNotToExceed, CostJustification,
  EmailSubject, EmailBody, PDFBlobName, SentAt, SentBy,
  CreatedAt, CreatedBy, UpdatedAt
`;

// ── GET /api/getPurchaseOrders?jobId=N ───────────────────────────────────────

async function getPurchaseOrders(
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
      `SELECT ${PO_COLUMNS} FROM PurchaseOrders WHERE JobID = @JobID ORDER BY Seq ASC`,
      [{ name: "JobID", type: TYPES.Int, value: Number(jobId) }],
    );
    return { status: 200, jsonBody: { count: rows.length, purchaseOrders: rows } };
  } catch (error: any) {
    context.error("getPurchaseOrders failed:", error.message);
    return errorResponse("Failed to fetch purchase orders", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/upsertPurchaseOrder ────────────────────────────────────────────
// Body: {
//   PurchaseOrderID?, JobID (required for create),
//   ContractorID?, ContractorName?, Scope?, EstimatedCost?, CostNotToExceed?,
//   CostJustification?, EmailSubject?, EmailBody?, CreatedBy?
// }
// On create, PONumber = `{YYMMDD}-PO-{JobID}-{ACR}-{Seq}`.
//   ACR is the contractor's 3-letter acronym (lazy-populated on first use),
//       or "INT" for internal jobs with no contractor.
//   Seq is per-contractor (total POs to this contractor ever + 1),
//       or per-job for internal (no-contractor) jobs.
// Wrapped in a transaction with UPDLOCK/HOLDLOCK on the MAX(Seq) read so
// concurrent creates can't collide on the same seq number.

async function upsertPurchaseOrder(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const {
      PurchaseOrderID,
      JobID,
      ContractorID,
      ContractorName,
      Scope,
      EstimatedCost,
      CostNotToExceed,
      CostJustification,
      EmailSubject,
      EmailBody,
      CreatedBy,
    } = body ?? {};

    connection = await createConnection(token);

    if (PurchaseOrderID === undefined) {
      // Create — runs in a tx so the SELECT MAX(Seq) + INSERT pair is atomic
      // and concurrent creates can't claim the same seq number.
      if (typeof JobID !== "number") {
        return { status: 400, jsonBody: { error: "JobID (number) required to create a PO" } };
      }

      // Once the business has approved a quote for this job, no new POs.
      const approvedRows = await executeQuery(
        connection,
        "SELECT ApprovedQuoteID FROM Jobs WHERE JobID = @JobID",
        [{ name: "JobID", type: TYPES.Int, value: JobID }],
      );
      if (approvedRows[0]?.ApprovedQuoteID != null) {
        return {
          status: 400,
          jsonBody: {
            error:
              "A quote has already been approved for this job — unapprove it first to add more POs.",
          },
        };
      }

      await beginTransaction(connection);
      try {
        const acronym =
          typeof ContractorID === "number"
            ? await ensureContractorAcronym(connection, ContractorID)
            : INTERNAL_ACRONYM;

        // Per-contractor seq for normal POs, per-job seq for internal ones.
        // UPDLOCK + HOLDLOCK take a key-range lock over the aggregated set so
        // another session blocks until this tx commits.
        const seqSql =
          typeof ContractorID === "number"
            ? `SELECT ISNULL(MAX(Seq), 0) + 1 AS NextSeq
                 FROM PurchaseOrders WITH (UPDLOCK, HOLDLOCK)
                WHERE ContractorID = @ContractorID`
            : `SELECT ISNULL(MAX(Seq), 0) + 1 AS NextSeq
                 FROM PurchaseOrders WITH (UPDLOCK, HOLDLOCK)
                WHERE JobID = @JobID AND ContractorID IS NULL`;
        const seqParams =
          typeof ContractorID === "number"
            ? [{ name: "ContractorID", type: TYPES.Int, value: ContractorID }]
            : [{ name: "JobID", type: TYPES.Int, value: JobID }];
        const seqRows = await executeQuery(connection, seqSql, seqParams);
        const nextSeq = (seqRows[0]?.NextSeq as number) ?? 1;

        const poNumber = formatDocNumber({
          prefix: "PO",
          jobId: JobID,
          acronym,
          seq: nextSeq,
        });

        const inserted = await executeQuery(
          connection,
          `INSERT INTO PurchaseOrders
             (JobID, PONumber, Seq, ContractorID, ContractorName, Scope,
              EstimatedCost, CostNotToExceed, CostJustification,
              EmailSubject, EmailBody, CreatedBy)
           OUTPUT INSERTED.PurchaseOrderID
           VALUES
             (@JobID, @PONumber, @Seq, @ContractorID, @ContractorName, @Scope,
              @EstimatedCost, @CostNotToExceed, @CostJustification,
              @EmailSubject, @EmailBody, @CreatedBy);`,
          [
            { name: "JobID", type: TYPES.Int, value: JobID },
            { name: "PONumber", type: TYPES.NVarChar, value: poNumber },
            { name: "Seq", type: TYPES.Int, value: nextSeq },
            { name: "ContractorID", type: TYPES.Int, value: ContractorID ?? null },
            { name: "ContractorName", type: TYPES.NVarChar, value: ContractorName ?? null },
            { name: "Scope", type: TYPES.NVarChar, value: Scope ?? null },
            { name: "EstimatedCost", type: TYPES.Decimal, value: EstimatedCost ?? null },
            { name: "CostNotToExceed", type: TYPES.Decimal, value: CostNotToExceed ?? null },
            { name: "CostJustification", type: TYPES.NVarChar, value: CostJustification ?? null },
            { name: "EmailSubject", type: TYPES.NVarChar, value: EmailSubject ?? null },
            { name: "EmailBody", type: TYPES.NVarChar, value: EmailBody ?? null },
            { name: "CreatedBy", type: TYPES.NVarChar, value: CreatedBy ?? null },
          ],
        );
        const newId = inserted[0].PurchaseOrderID as number;
        await commitTransaction(connection);

        const stored = await executeQuery(
          connection,
          `SELECT ${PO_COLUMNS} FROM PurchaseOrders WHERE PurchaseOrderID = @Id`,
          [{ name: "Id", type: TYPES.Int, value: newId }],
        );
        return { status: 200, jsonBody: { purchaseOrder: stored[0] } };
      } catch (err) {
        await rollbackTransaction(connection).catch(() => {});
        throw err;
      }
    }

    // Update
    if (typeof PurchaseOrderID !== "number") {
      return { status: 400, jsonBody: { error: "PurchaseOrderID must be a number" } };
    }
    const fields: string[] = ["UpdatedAt = SYSUTCDATETIME()"];
    const params: { name: string; type: any; value: any }[] = [
      { name: "Id", type: TYPES.Int, value: PurchaseOrderID },
    ];
    const push = (col: string, type: any, val: unknown) => {
      fields.push(`${col} = @${col}`);
      params.push({ name: col, type, value: val ?? null });
    };
    if (ContractorID !== undefined) push("ContractorID", TYPES.Int, ContractorID);
    if (ContractorName !== undefined) push("ContractorName", TYPES.NVarChar, ContractorName);
    if (Scope !== undefined) push("Scope", TYPES.NVarChar, Scope);
    if (EstimatedCost !== undefined) push("EstimatedCost", TYPES.Decimal, EstimatedCost);
    if (CostNotToExceed !== undefined) push("CostNotToExceed", TYPES.Decimal, CostNotToExceed);
    if (CostJustification !== undefined)
      push("CostJustification", TYPES.NVarChar, CostJustification);
    if (EmailSubject !== undefined) push("EmailSubject", TYPES.NVarChar, EmailSubject);
    if (EmailBody !== undefined) push("EmailBody", TYPES.NVarChar, EmailBody);

    await executeQuery(
      connection,
      `UPDATE PurchaseOrders SET ${fields.join(", ")} WHERE PurchaseOrderID = @Id`,
      params,
    );
    const stored = await executeQuery(
      connection,
      `SELECT ${PO_COLUMNS} FROM PurchaseOrders WHERE PurchaseOrderID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: PurchaseOrderID }],
    );
    if (stored.length === 0) {
      return { status: 404, jsonBody: { error: "Purchase order not found" } };
    }
    return { status: 200, jsonBody: { purchaseOrder: stored[0] } };
  } catch (error: any) {
    context.error("upsertPurchaseOrder failed:", error.message);
    return errorResponse("Upsert purchase order failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/previewPurchaseOrder ───────────────────────────────────────────
// Body: { PurchaseOrderID }
// Renders the PO PDF from current PO + Job snapshot data, uploads it under
// the deterministic key po/{id}.pdf (overwriting any prior preview), stores
// the blob name on the PO row, and returns a short-lived SAS URL that the
// frontend can hand to an <iframe> for inline preview. Re-calling regenerates.

async function previewPurchaseOrder(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const { PurchaseOrderID } = body ?? {};
    if (typeof PurchaseOrderID !== "number") {
      return { status: 400, jsonBody: { error: "PurchaseOrderID (number) required" } };
    }

    connection = await createConnection(token);

    // Fetch PO + Job snapshot + contractor email in one round-trip
    const rows = await executeQuery(
      connection,
      `SELECT
         po.PurchaseOrderID, po.JobID, po.PONumber, po.Seq, po.ContractorID,
         po.ContractorName, po.Scope, po.EstimatedCost, po.CostNotToExceed,
         po.CostJustification, po.EmailSubject, po.EmailBody, po.PDFBlobName,
         po.SentAt, po.SentBy, po.CreatedAt, po.CreatedBy, po.UpdatedAt,
         j.Title AS JobTitle, j.JobCode, j.LevelName, j.TenantName,
         j.Category, j.[Type] AS JobType, j.SubType, j.Priority,
         j.ExactLocation, j.ContactName, j.ContactPhone, j.ContactEmail,
         j.PersonAffected,
         b.BuildingName,
         c.EmailAddress AS ContractorEmail
       FROM PurchaseOrders po
       INNER JOIN Jobs j ON j.JobID = po.JobID
       LEFT JOIN Buildings b ON b.BuildingID = j.BuildingID
       LEFT JOIN Contractors c ON c.ContractorID = po.ContractorID
       WHERE po.PurchaseOrderID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: PurchaseOrderID }],
    );
    if (rows.length === 0) {
      return { status: 404, jsonBody: { error: "Purchase order not found" } };
    }
    const r = rows[0];

    const pdfBuffer = await renderPurchaseOrderPDF({
      po: {
        poNumber: r.PONumber ?? null,
        contractorName: r.ContractorName ?? null,
        contractorEmail: r.ContractorEmail ?? null,
        scope: r.Scope ?? null,
        estimatedCost: r.EstimatedCost ?? null,
        costNotToExceed: r.CostNotToExceed ?? null,
        costJustification: r.CostJustification ?? null,
        createdBy: r.CreatedBy ?? null,
        createdAt: r.CreatedAt ?? null,
      },
      job: {
        jobCode: r.JobCode ?? null,
        title: r.JobTitle ?? null,
        buildingName: r.BuildingName ?? null,
        levelName: r.LevelName ?? null,
        exactLocation: r.ExactLocation ?? null,
        category: r.Category ?? null,
        type: r.JobType ?? null,
        subType: r.SubType ?? null,
        priority: r.Priority ?? null,
        contactName: r.ContactName ?? null,
        contactPhone: r.ContactPhone ?? null,
        contactEmail: r.ContactEmail ?? null,
        personAffected: r.PersonAffected ?? null,
      },
    });

    const { blobName } = await uploadPurchaseOrderPdf(PurchaseOrderID, pdfBuffer);

    // Populate default email subject + body on first preview so the UI can
    // show something sensible. User edits via upsertPurchaseOrder win
    // (COALESCE keeps whatever's already stored).
    const defaults = defaultPOEmail({
      po: {
        poNumber: r.PONumber ?? null,
        contractorName: r.ContractorName ?? null,
        scope: r.Scope ?? null,
        estimatedCost: r.EstimatedCost ?? null,
        costNotToExceed: r.CostNotToExceed ?? null,
        costJustification: r.CostJustification ?? null,
        createdBy: r.CreatedBy ?? null,
      },
      job: {
        jobCode: r.JobCode ?? null,
        title: r.JobTitle ?? null,
        buildingName: r.BuildingName ?? null,
        levelName: r.LevelName ?? null,
        exactLocation: r.ExactLocation ?? null,
        category: r.Category ?? null,
        type: r.JobType ?? null,
        subType: r.SubType ?? null,
        contactName: r.ContactName ?? null,
        contactPhone: r.ContactPhone ?? null,
        contactEmail: r.ContactEmail ?? null,
      },
    });

    await executeQuery(
      connection,
      `UPDATE PurchaseOrders
         SET PDFBlobName = @BlobName,
             EmailSubject = COALESCE(EmailSubject, @DefaultSubject),
             EmailBody    = COALESCE(EmailBody, @DefaultBody),
             UpdatedAt    = SYSUTCDATETIME()
       WHERE PurchaseOrderID = @Id`,
      [
        { name: "Id", type: TYPES.Int, value: PurchaseOrderID },
        { name: "BlobName", type: TYPES.NVarChar, value: blobName },
        { name: "DefaultSubject", type: TYPES.NVarChar, value: defaults.subject },
        { name: "DefaultBody", type: TYPES.NVarChar, value: defaults.body },
      ],
    );

    const stored = await executeQuery(
      connection,
      `SELECT ${PO_COLUMNS} FROM PurchaseOrders WHERE PurchaseOrderID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: PurchaseOrderID }],
    );

    const recipient = resolveRecipient(r.ContractorEmail ?? null);
    const url = generateReadSasUrl(blobName, 60 * 60 * 1000); // 1 hour
    return {
      status: 200,
      jsonBody: {
        purchaseOrder: stored[0],
        url,
        recipient: recipient.address,
        recipientOriginal: recipient.original,
        recipientOverridden: recipient.overridden,
      },
    };
  } catch (error: any) {
    context.error("previewPurchaseOrder failed:", error.message);
    return errorResponse("Preview purchase order failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/sendPurchaseOrder ──────────────────────────────────────────────
// Body: { PurchaseOrderID, SentBy }
// Requires PDFBlobName to be set — caller must hit previewPurchaseOrder first.
// Flips SentAt/SentBy. Actual Microsoft Graph sendMail call is follow-on work
// — resolveRecipient + the generated PDF are ready for that wiring.

async function sendPurchaseOrder(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const { PurchaseOrderID, SentBy } = body ?? {};
    if (typeof PurchaseOrderID !== "number") {
      return { status: 400, jsonBody: { error: "PurchaseOrderID (number) required" } };
    }

    connection = await createConnection(token);

    const contractorRows = await executeQuery(
      connection,
      `SELECT c.EmailAddress, po.PDFBlobName, j.ApprovedQuoteID
         FROM PurchaseOrders po
         INNER JOIN Jobs j ON j.JobID = po.JobID
         LEFT JOIN Contractors c ON c.ContractorID = po.ContractorID
        WHERE po.PurchaseOrderID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: PurchaseOrderID }],
    );
    if (contractorRows.length === 0) {
      return { status: 404, jsonBody: { error: "Purchase order not found" } };
    }
    if (contractorRows[0].ApprovedQuoteID != null) {
      return {
        status: 400,
        jsonBody: {
          error:
            "A quote has already been approved for this job — unapprove it first to send more POs.",
        },
      };
    }
    if (!contractorRows[0]?.PDFBlobName) {
      return {
        status: 400,
        jsonBody: { error: "Preview the PO (generate a PDF) before sending." },
      };
    }
    const recipient = resolveRecipient(contractorRows[0]?.EmailAddress);
    const pdfBlobName = contractorRows[0].PDFBlobName as string;
    context.log(
      `[sendPurchaseOrder] PO#${PurchaseOrderID} → ${recipient.address ?? "(no recipient)"}${
        recipient.overridden ? ` (overridden from ${recipient.original ?? "(none)"})` : ""
      } · pdf=${pdfBlobName}`,
    );
    // TODO: Microsoft Graph sendMail — fetch blob `pdfBlobName`, attach, send
    // to `recipient.address` with subject/body from the PO row.

    await executeQuery(
      connection,
      `UPDATE PurchaseOrders
       SET SentAt = SYSUTCDATETIME(), SentBy = @SentBy, UpdatedAt = SYSUTCDATETIME()
       WHERE PurchaseOrderID = @Id`,
      [
        { name: "Id", type: TYPES.Int, value: PurchaseOrderID },
        { name: "SentBy", type: TYPES.NVarChar, value: SentBy ?? null },
      ],
    );
    const stored = await executeQuery(
      connection,
      `SELECT ${PO_COLUMNS} FROM PurchaseOrders WHERE PurchaseOrderID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: PurchaseOrderID }],
    );
    return {
      status: 200,
      jsonBody: {
        purchaseOrder: stored[0],
        recipient: recipient.address,
        recipientOverridden: recipient.overridden,
      },
    };
  } catch (error: any) {
    context.error("sendPurchaseOrder failed:", error.message);
    return errorResponse("Send purchase order failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/deletePurchaseOrder ────────────────────────────────────────────
// Body: { PurchaseOrderID }
// Refuses to delete if SentAt is set — a sent PO is a real-world obligation
// and should not vanish silently. Best-effort blob cleanup on success.

async function deletePurchaseOrder(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const { PurchaseOrderID } = body ?? {};
    if (typeof PurchaseOrderID !== "number") {
      return { status: 400, jsonBody: { error: "PurchaseOrderID (number) required" } };
    }

    connection = await createConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT SentAt, PDFBlobName FROM PurchaseOrders WHERE PurchaseOrderID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: PurchaseOrderID }],
    );
    if (rows.length === 0) {
      return { status: 404, jsonBody: { error: "Purchase order not found" } };
    }
    if (rows[0].SentAt) {
      return {
        status: 400,
        jsonBody: { error: "Cannot delete a purchase order that has been sent." },
      };
    }

    await executeQuery(
      connection,
      `DELETE FROM PurchaseOrders WHERE PurchaseOrderID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: PurchaseOrderID }],
    );

    const pdfBlobName = rows[0].PDFBlobName as string | null;
    if (pdfBlobName) {
      // Best-effort — if blob cleanup fails we don't want to resurrect the row.
      deleteBlob(pdfBlobName).catch((err) =>
        context.warn(`deletePurchaseOrder: blob cleanup failed for ${pdfBlobName}: ${err?.message}`),
      );
    }

    return { status: 200, jsonBody: { deleted: true, purchaseOrderId: PurchaseOrderID } };
  } catch (error: any) {
    context.error("deletePurchaseOrder failed:", error.message);
    return errorResponse("Delete purchase order failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getPurchaseOrders", {
  methods: ["GET"],
  authLevel: "anonymous",
  handler: getPurchaseOrders,
});
app.http("upsertPurchaseOrder", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: upsertPurchaseOrder,
});
app.http("sendPurchaseOrder", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: sendPurchaseOrder,
});
app.http("previewPurchaseOrder", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: previewPurchaseOrder,
});
app.http("deletePurchaseOrder", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: deletePurchaseOrder,
});
