// Purchase Orders — CRUD + "send" stub. The send endpoint persists the
// outgoing email metadata and flips SentAt/SentBy; actual PDF generation
// and Microsoft Graph sendMail are follow-on work that plug into the same
// endpoint without schema changes.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import {
  beginTransaction,
  buildUpdateSet,
  closeConnection,
  commitTransaction,
  createConnection,
  executeQuery,
  rollbackTransaction,
} from "../db";
import { extractToken, unauthorizedResponse, errorResponse } from "../auth";
import { resolveRecipient } from "../email-recipient";
import { graphSendMail } from "../graph";
import { renderPurchaseOrderPDF } from "../pdf/purchase-order-pdf";
import { defaultPOEmail } from "../pdf/default-po-email";
import {
  deleteBlob,
  downloadBlob,
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
  MyobCreatedAt, MyobCreatedBy, CompletedAt, CompletedBy,
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
    const update = buildUpdateSet(
      {
        ContractorID: TYPES.Int,
        ContractorName: TYPES.NVarChar,
        CostJustification: TYPES.NVarChar,
        CostNotToExceed: TYPES.Decimal,
        EmailBody: TYPES.NVarChar,
        EmailSubject: TYPES.NVarChar,
        EstimatedCost: TYPES.Decimal,
        Scope: TYPES.NVarChar,
      },
      {
        ContractorID,
        ContractorName,
        CostJustification,
        CostNotToExceed,
        EmailBody,
        EmailSubject,
        EstimatedCost,
        Scope,
      },
    );
    // UpdatedAt is always bumped on an update — it's a SQL expression, not a
    // user value, so it lives outside the allowlist.
    const setClause = update
      ? `${update.setClause}, UpdatedAt = SYSUTCDATETIME()`
      : "UpdatedAt = SYSUTCDATETIME()";

    await executeQuery(
      connection,
      `UPDATE PurchaseOrders SET ${setClause} WHERE PurchaseOrderID = @Id`,
      [
        { name: "Id", type: TYPES.Int, value: PurchaseOrderID },
        ...(update?.params ?? []),
      ],
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
    const { PurchaseOrderID, SentBy, SentByEmail } = body ?? {};
    if (typeof PurchaseOrderID !== "number") {
      return { status: 400, jsonBody: { error: "PurchaseOrderID (number) required" } };
    }

    connection = await createConnection(token);

    const contractorRows = await executeQuery(
      connection,
      `SELECT c.EmailAddress, po.PDFBlobName, po.PONumber,
              po.EmailSubject, po.EmailBody
         FROM PurchaseOrders po
         LEFT JOIN Contractors c ON c.ContractorID = po.ContractorID
        WHERE po.PurchaseOrderID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: PurchaseOrderID }],
    );
    if (contractorRows.length === 0) {
      return { status: 404, jsonBody: { error: "Purchase order not found" } };
    }
    if (!contractorRows[0]?.PDFBlobName) {
      return {
        status: 400,
        jsonBody: { error: "Preview the PO (generate a PDF) before sending." },
      };
    }
    const recipient = resolveRecipient(contractorRows[0]?.EmailAddress);
    if (!recipient.address) {
      return { status: 400, jsonBody: { error: "Contractor has no email address." } };
    }
    const pdfBlobName = contractorRows[0].PDFBlobName as string;
    const poNumber = contractorRows[0].PONumber as string | null;
    const emailSubject = (contractorRows[0].EmailSubject as string | null) ?? poNumber ?? "Purchase Order";
    const emailBody = (contractorRows[0].EmailBody as string | null) ?? "";

    context.log(
      `[sendPurchaseOrder] PO#${PurchaseOrderID} → ${recipient.address}${
        recipient.overridden ? ` (overridden from ${recipient.original ?? "(none)"})` : ""
      } · pdf=${pdfBlobName}`,
    );

    const pdfBuffer = await downloadBlob(pdfBlobName);
    const ccAddresses = typeof SentByEmail === "string" && SentByEmail ? [SentByEmail] : undefined;
    await graphSendMail(
      recipient.address,
      emailSubject,
      emailBody,
      [
        {
          fileName: `${poNumber ?? `PO-${PurchaseOrderID}`}.pdf`,
          contentType: "application/pdf",
          contentBase64: pdfBuffer.toString("base64"),
        },
      ],
      ccAddresses,
    );

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
      `SELECT SentAt, CompletedAt, PDFBlobName FROM PurchaseOrders WHERE PurchaseOrderID = @Id`,
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
    if (rows[0].CompletedAt) {
      return {
        status: 400,
        jsonBody: { error: "Cannot delete a purchase order that has been marked complete." },
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

// ── POST /api/markPurchaseOrderMyobCreated ───────────────────────────────────
// Body: { id, jobId, createdBy }
// Records that this PO has been entered into MYOB. Cannot be undone once
// CompletedAt is set.

async function markPurchaseOrderMyobCreated(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const { id, jobId, createdBy } = body ?? {};
    if (typeof id !== "number") {
      return { status: 400, jsonBody: { error: "id (number) required" } };
    }
    if (typeof jobId !== "number") {
      return { status: 400, jsonBody: { error: "jobId (number) required" } };
    }

    connection = await createConnection(token);

    const rows = await executeQuery(
      connection,
      `SELECT PurchaseOrderID FROM PurchaseOrders WHERE PurchaseOrderID = @Id AND JobID = @JobID`,
      [
        { name: "Id", type: TYPES.Int, value: id },
        { name: "JobID", type: TYPES.Int, value: jobId },
      ],
    );
    if (rows.length === 0) {
      return { status: 404, jsonBody: { error: "Purchase order not found" } };
    }

    await executeQuery(
      connection,
      `UPDATE PurchaseOrders
         SET MyobCreatedAt = SYSUTCDATETIME(), MyobCreatedBy = @CreatedBy, UpdatedAt = SYSUTCDATETIME()
       WHERE PurchaseOrderID = @Id AND JobID = @JobID`,
      [
        { name: "Id", type: TYPES.Int, value: id },
        { name: "JobID", type: TYPES.Int, value: jobId },
        { name: "CreatedBy", type: TYPES.NVarChar, value: createdBy ?? null },
      ],
    );
    await executeQuery(
      connection,
      `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, PurchaseOrderID)
       VALUES (@JobID, @CreatedBy, @Text, 'po_myob_created', @PurchaseOrderID);`,
      [
        { name: "JobID", type: TYPES.Int, value: jobId },
        { name: "CreatedBy", type: TYPES.NVarChar, value: createdBy ?? null },
        { name: "Text", type: TYPES.NVarChar, value: `Marked PO #${id} as created in MYOB` },
        { name: "PurchaseOrderID", type: TYPES.Int, value: id },
      ],
    );
    await executeQuery(
      connection,
      "UPDATE Jobs SET LastModifiedDate = SYSUTCDATETIME() WHERE JobID = @JobID",
      [{ name: "JobID", type: TYPES.Int, value: jobId }],
    );

    const stored = await executeQuery(
      connection,
      `SELECT ${PO_COLUMNS} FROM PurchaseOrders WHERE PurchaseOrderID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: id }],
    );
    return { status: 200, jsonBody: { purchaseOrder: stored[0] } };
  } catch (error: any) {
    context.error("markPurchaseOrderMyobCreated failed:", error.message);
    return errorResponse("Mark MYOB created failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/unmarkPurchaseOrderMyobCreated ─────────────────────────────────
// Body: { id, jobId }
// Clears the MyobCreatedAt/By fields. Refused if CompletedAt is already set —
// cannot undo MYOB entry after the PO has been completed.

async function unmarkPurchaseOrderMyobCreated(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const { id, jobId } = body ?? {};
    if (typeof id !== "number") {
      return { status: 400, jsonBody: { error: "id (number) required" } };
    }
    if (typeof jobId !== "number") {
      return { status: 400, jsonBody: { error: "jobId (number) required" } };
    }

    connection = await createConnection(token);

    const rows = await executeQuery(
      connection,
      `SELECT CompletedAt FROM PurchaseOrders WHERE PurchaseOrderID = @Id AND JobID = @JobID`,
      [
        { name: "Id", type: TYPES.Int, value: id },
        { name: "JobID", type: TYPES.Int, value: jobId },
      ],
    );
    if (rows.length === 0) {
      return { status: 404, jsonBody: { error: "Purchase order not found" } };
    }
    if (rows[0].CompletedAt) {
      return {
        status: 400,
        jsonBody: { error: "Cannot undo MYOB entry — this purchase order has already been marked complete." },
      };
    }

    await executeQuery(
      connection,
      `UPDATE PurchaseOrders
         SET MyobCreatedAt = NULL, MyobCreatedBy = NULL, UpdatedAt = SYSUTCDATETIME()
       WHERE PurchaseOrderID = @Id AND JobID = @JobID`,
      [
        { name: "Id", type: TYPES.Int, value: id },
        { name: "JobID", type: TYPES.Int, value: jobId },
      ],
    );
    await executeQuery(
      connection,
      `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, PurchaseOrderID)
       VALUES (@JobID, NULL, @Text, 'po_myob_uncreated', @PurchaseOrderID);`,
      [
        { name: "JobID", type: TYPES.Int, value: jobId },
        { name: "Text", type: TYPES.NVarChar, value: `Unmarked PO #${id} from MYOB created` },
        { name: "PurchaseOrderID", type: TYPES.Int, value: id },
      ],
    );
    await executeQuery(
      connection,
      "UPDATE Jobs SET LastModifiedDate = SYSUTCDATETIME() WHERE JobID = @JobID",
      [{ name: "JobID", type: TYPES.Int, value: jobId }],
    );

    const stored = await executeQuery(
      connection,
      `SELECT ${PO_COLUMNS} FROM PurchaseOrders WHERE PurchaseOrderID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: id }],
    );
    return { status: 200, jsonBody: { purchaseOrder: stored[0] } };
  } catch (error: any) {
    context.error("unmarkPurchaseOrderMyobCreated failed:", error.message);
    return errorResponse("Unmark MYOB created failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/markPurchaseOrderComplete ──────────────────────────────────────
// Body: { id, jobId, completedBy }
// Requires MyobCreatedAt to be set first. Transitions the job to
// status='Awaiting Approval', awaitingRole='accounts'.

async function markPurchaseOrderComplete(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const { id, jobId, completedBy } = body ?? {};
    if (typeof id !== "number") {
      return { status: 400, jsonBody: { error: "id (number) required" } };
    }
    if (typeof jobId !== "number") {
      return { status: 400, jsonBody: { error: "jobId (number) required" } };
    }

    connection = await createConnection(token);

    const rows = await executeQuery(
      connection,
      `SELECT MyobCreatedAt, CompletedAt FROM PurchaseOrders WHERE PurchaseOrderID = @Id AND JobID = @JobID`,
      [
        { name: "Id", type: TYPES.Int, value: id },
        { name: "JobID", type: TYPES.Int, value: jobId },
      ],
    );
    if (rows.length === 0) {
      return { status: 404, jsonBody: { error: "Purchase order not found" } };
    }
    if (!rows[0].MyobCreatedAt) {
      return {
        status: 400,
        jsonBody: { error: "Cannot mark complete — this purchase order has not been marked as created in MYOB yet." },
      };
    }

    await executeQuery(
      connection,
      `UPDATE PurchaseOrders
         SET CompletedAt = SYSUTCDATETIME(), CompletedBy = @CompletedBy, UpdatedAt = SYSUTCDATETIME()
       WHERE PurchaseOrderID = @Id AND JobID = @JobID`,
      [
        { name: "Id", type: TYPES.Int, value: id },
        { name: "JobID", type: TYPES.Int, value: jobId },
        { name: "CompletedBy", type: TYPES.NVarChar, value: completedBy ?? null },
      ],
    );

    // Fire PO event
    await executeQuery(
      connection,
      `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, PurchaseOrderID)
       VALUES (@JobID, @CreatedBy, @Text, 'po_completed', @PurchaseOrderID);`,
      [
        { name: "JobID", type: TYPES.Int, value: jobId },
        { name: "CreatedBy", type: TYPES.NVarChar, value: completedBy ?? null },
        { name: "Text", type: TYPES.NVarChar, value: `Marked PO #${id} complete` },
        { name: "PurchaseOrderID", type: TYPES.Int, value: id },
      ],
    );

    // Transition the job: Awaiting Approval, accounts team
    await executeQuery(
      connection,
      `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, NewStatus, NewAwaitingRole)
       VALUES (@JobID, @CreatedBy, @Text, 'status_changed', 'Awaiting Approval', 'accounts');`,
      [
        { name: "JobID", type: TYPES.Int, value: jobId },
        { name: "CreatedBy", type: TYPES.NVarChar, value: completedBy ?? null },
        { name: "Text", type: TYPES.NVarChar, value: "Work complete — awaiting accounts approval" },
      ],
    );
    await executeQuery(
      connection,
      `UPDATE Jobs SET Status = 'Awaiting Approval', AwaitingRole = 'accounts', LastModifiedDate = SYSUTCDATETIME()
       WHERE JobID = @JobID`,
      [{ name: "JobID", type: TYPES.Int, value: jobId }],
    );

    const stored = await executeQuery(
      connection,
      `SELECT ${PO_COLUMNS} FROM PurchaseOrders WHERE PurchaseOrderID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: id }],
    );
    return { status: 200, jsonBody: { purchaseOrder: stored[0] } };
  } catch (error: any) {
    context.error("markPurchaseOrderComplete failed:", error.message);
    return errorResponse("Mark complete failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/unmarkPurchaseOrderComplete ────────────────────────────────────
// Body: { id, jobId }
// Clears CompletedAt/By and rolls the job back to status='Work', awaitingRole='facilities'.

async function unmarkPurchaseOrderComplete(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const { id, jobId } = body ?? {};
    if (typeof id !== "number") {
      return { status: 400, jsonBody: { error: "id (number) required" } };
    }
    if (typeof jobId !== "number") {
      return { status: 400, jsonBody: { error: "jobId (number) required" } };
    }

    connection = await createConnection(token);

    const rows = await executeQuery(
      connection,
      `SELECT PurchaseOrderID FROM PurchaseOrders WHERE PurchaseOrderID = @Id AND JobID = @JobID`,
      [
        { name: "Id", type: TYPES.Int, value: id },
        { name: "JobID", type: TYPES.Int, value: jobId },
      ],
    );
    if (rows.length === 0) {
      return { status: 404, jsonBody: { error: "Purchase order not found" } };
    }

    await executeQuery(
      connection,
      `UPDATE PurchaseOrders
         SET CompletedAt = NULL, CompletedBy = NULL, UpdatedAt = SYSUTCDATETIME()
       WHERE PurchaseOrderID = @Id AND JobID = @JobID`,
      [
        { name: "Id", type: TYPES.Int, value: id },
        { name: "JobID", type: TYPES.Int, value: jobId },
      ],
    );

    // Fire PO event
    await executeQuery(
      connection,
      `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, PurchaseOrderID)
       VALUES (@JobID, NULL, @Text, 'po_uncompleted', @PurchaseOrderID);`,
      [
        { name: "JobID", type: TYPES.Int, value: jobId },
        { name: "Text", type: TYPES.NVarChar, value: `Unmarked PO #${id} as complete` },
        { name: "PurchaseOrderID", type: TYPES.Int, value: id },
      ],
    );

    // Roll back job status
    await executeQuery(
      connection,
      `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, NewStatus, NewAwaitingRole)
       VALUES (@JobID, NULL, @Text, 'status_changed', 'Work', 'facilities');`,
      [
        { name: "JobID", type: TYPES.Int, value: jobId },
        { name: "Text", type: TYPES.NVarChar, value: "Completion undone — back to work in progress" },
      ],
    );
    await executeQuery(
      connection,
      `UPDATE Jobs SET Status = 'Work', AwaitingRole = 'facilities', LastModifiedDate = SYSUTCDATETIME()
       WHERE JobID = @JobID`,
      [{ name: "JobID", type: TYPES.Int, value: jobId }],
    );

    const stored = await executeQuery(
      connection,
      `SELECT ${PO_COLUMNS} FROM PurchaseOrders WHERE PurchaseOrderID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: id }],
    );
    return { status: 200, jsonBody: { purchaseOrder: stored[0] } };
  } catch (error: any) {
    context.error("unmarkPurchaseOrderComplete failed:", error.message);
    return errorResponse("Unmark complete failed", error.message);
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
app.http("markPurchaseOrderMyobCreated", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: markPurchaseOrderMyobCreated,
});
app.http("unmarkPurchaseOrderMyobCreated", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: unmarkPurchaseOrderMyobCreated,
});
app.http("markPurchaseOrderComplete", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: markPurchaseOrderComplete,
});
app.http("unmarkPurchaseOrderComplete", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: unmarkPurchaseOrderComplete,
});
