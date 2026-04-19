// ─────────────────────────────────────────────────────────────────────────────
// Attachment handlers: upload + list.
//
// Upload flow: client → Azure Function (multipart) → blob storage → generate
// SAS URL → POST to myBuildings uploadAttachment → record row in SQL.
//
// List flow: returns rows from SQL with a freshly-minted read SAS URL so the
// frontend can display/preview without us exposing blobs publicly.
// ─────────────────────────────────────────────────────────────────────────────

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { closeConnection, createConnection, executeQuery } from "../db";
import { extractToken, errorResponse, unauthorizedResponse } from "../auth";
import { deleteBlob, generateReadSasUrl, uploadBlob } from "../blob-storage";
import { uploadAttachment } from "../mybuildings-client";

const MAX_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB
const ALLOWED_PREFIXES = [
  "image/",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.",
  "text/plain",
];

function isAllowedContentType(contentType: string): boolean {
  return ALLOWED_PREFIXES.some((p) => contentType.startsWith(p));
}

// ── POST /api/uploadAttachment (multipart/form-data) ─────────────────────────
// Accepts either `jobId` (preferred — new attachments belong to a Job) or
// `workRequestId` (legacy intake path: the WR has not been promoted to a
// Job yet, so we land with JobID NULL and let upsertJob claim the row when
// the Job is created). At least one is required.

async function handleUploadAttachment(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const form = await request.formData();
    const file = form.get("file") as unknown as File | null;
    const jobIdRaw = form.get("jobId");
    const workRequestIdRaw = form.get("workRequestId");
    const jobCode = form.get("jobCode")?.toString() ?? null;
    const uploadedBy = form.get("uploadedBy")?.toString() ?? null;

    if (!file || typeof (file as any).arrayBuffer !== "function") {
      return { status: 400, jsonBody: { error: "Missing 'file' field in multipart body" } };
    }
    if (!jobIdRaw && !workRequestIdRaw) {
      return { status: 400, jsonBody: { error: "Missing 'jobId' or 'workRequestId' field" } };
    }

    const jobId = jobIdRaw ? parseInt(jobIdRaw.toString(), 10) : null;
    const workRequestId = workRequestIdRaw ? parseInt(workRequestIdRaw.toString(), 10) : null;
    if (jobId !== null && !Number.isFinite(jobId)) {
      return { status: 400, jsonBody: { error: "'jobId' must be a number" } };
    }
    if (workRequestId !== null && !Number.isFinite(workRequestId)) {
      return { status: 400, jsonBody: { error: "'workRequestId' must be a number" } };
    }

    const contentType = (file as any).type || "application/octet-stream";
    if (!isAllowedContentType(contentType)) {
      return { status: 415, jsonBody: { error: `File type '${contentType}' is not allowed` } };
    }

    const size = (file as any).size as number;
    if (size > MAX_SIZE_BYTES) {
      return { status: 413, jsonBody: { error: `File exceeds ${MAX_SIZE_BYTES / 1024 / 1024} MB limit` } };
    }

    const originalName = (file as any).name as string;
    const buffer = Buffer.from(await (file as any).arrayBuffer());

    // Blob path uses the strongest scope we have: prefer job-scoped, fall back
    // to wr-scoped for legacy intake. Path is purely organisational — the row
    // is what actually anchors the file to a Job/WR.
    const keyPrefix = jobId !== null ? `job-${jobId}` : `${workRequestId}`;
    const scopeLabel =
      jobId !== null ? `Job ${jobId}` : `WR ${workRequestId}`;
    context.log(`Uploading ${originalName} (${contentType}, ${size} bytes) for ${scopeLabel}`);
    const { blobName } = await uploadBlob(buffer, originalName, contentType, keyPrefix);
    const sasUrl = generateReadSasUrl(blobName);

    // Push to myBuildings only when there's a WR to push it to. Job-scoped
    // uploads with no WR stay local.
    const extension = originalName.includes(".") ? originalName.split(".").pop() ?? "" : "";
    if (workRequestId !== null) {
      await uploadAttachment({
        Attachment_Extension: extension,
        Attachment_Name: originalName,
        Attachment_URL: sasUrl,
        JobCode: jobCode ?? undefined,
        WorkRequestID: workRequestId,
      });
    }

    // Record locally
    connection = await createConnection(token);
    const inserted = await executeQuery(
      connection,
      `INSERT INTO Attachments (JobID, WorkRequestID, JobCode, BlobName, OriginalName, Extension, ContentType, SizeBytes, UploadedBy)
       OUTPUT INSERTED.*
       VALUES (@JobID, @WorkRequestID, @JobCode, @BlobName, @OriginalName, @Extension, @ContentType, @SizeBytes, @UploadedBy)`,
      [
        { name: "JobID", type: TYPES.Int, value: jobId },
        { name: "WorkRequestID", type: TYPES.Int, value: workRequestId },
        { name: "JobCode", type: TYPES.NVarChar, value: jobCode },
        { name: "BlobName", type: TYPES.NVarChar, value: blobName },
        { name: "OriginalName", type: TYPES.NVarChar, value: originalName },
        { name: "Extension", type: TYPES.NVarChar, value: extension },
        { name: "ContentType", type: TYPES.NVarChar, value: contentType },
        { name: "SizeBytes", type: TYPES.BigInt, value: size },
        { name: "UploadedBy", type: TYPES.NVarChar, value: uploadedBy },
      ],
    );

    const row = inserted[0];
    return {
      status: 200,
      jsonBody: {
        attachment: { ...row, sasUrl },
      },
    };
  } catch (error: any) {
    context.error("uploadAttachment failed:", error.message);
    return errorResponse("Upload failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── GET /api/getAttachments?jobId=X | ?workRequestId=X ───────────────────────
// Pass `jobId` (preferred) for the job-scoped list, or `workRequestId` for
// the legacy WR-scoped view (used by the WR detail surfaces during cutover).

async function handleGetAttachments(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const jobIdRaw = request.query.get("jobId");
  const workRequestIdRaw = request.query.get("workRequestId");
  if (!jobIdRaw && !workRequestIdRaw) {
    return { status: 400, jsonBody: { error: "jobId or workRequestId is required" } };
  }
  const jobId = jobIdRaw ? parseInt(jobIdRaw, 10) : null;
  const workRequestId = workRequestIdRaw ? parseInt(workRequestIdRaw, 10) : null;
  if (jobId !== null && !Number.isFinite(jobId)) {
    return { status: 400, jsonBody: { error: "jobId must be a number" } };
  }
  if (workRequestId !== null && !Number.isFinite(workRequestId)) {
    return { status: 400, jsonBody: { error: "workRequestId must be a number" } };
  }

  let connection;
  try {
    connection = await createConnection(token);
    const rows = jobId !== null
      ? await executeQuery(
          connection,
          "SELECT * FROM Attachments WHERE JobID=@JobID ORDER BY UploadedAt DESC",
          [{ name: "JobID", type: TYPES.Int, value: jobId }],
        )
      : await executeQuery(
          connection,
          "SELECT * FROM Attachments WHERE WorkRequestID=@WorkRequestID ORDER BY UploadedAt DESC",
          [{ name: "WorkRequestID", type: TYPES.Int, value: workRequestId }],
        );

    // Mint a fresh read SAS for rows whose blob still exists. Once a blob has
    // been cleaned up (MyBuildingsConfirmedAt set), the SAS would 404 — return
    // null so the UI can show the row as archived.
    const attachments = rows.map((r: any) => ({
      ...r,
      sasUrl: r.MyBuildingsConfirmedAt ? null : generateReadSasUrl(r.BlobName),
    }));

    return { status: 200, jsonBody: { attachments, count: attachments.length } };
  } catch (error: any) {
    context.error("getAttachments failed:", error.message);
    return errorResponse("Fetch failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── Join-table helpers (PurchaseOrderAttachments / QuoteAttachments) ────────
// One pair of endpoints per parent. Idempotent attach (NOT EXISTS guard) so
// the FE can call without first checking; detach is a plain DELETE.

interface JoinSpec {
  table: string;
  parentColumn: string;
  parentParam: string;
}

const PO_JOIN: JoinSpec = {
  parentColumn: "PurchaseOrderID",
  parentParam: "PurchaseOrderID",
  table: "PurchaseOrderAttachments",
};
const QUOTE_JOIN: JoinSpec = {
  parentColumn: "QuoteID",
  parentParam: "QuoteID",
  table: "QuoteAttachments",
};

async function attachToParent(
  request: HttpRequest,
  context: InvocationContext,
  spec: JoinSpec,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const parentId = body?.[spec.parentParam];
    const attachmentId = body?.AttachmentID;
    const attachedBy = body?.AttachedBy ?? null;
    if (typeof parentId !== "number" || typeof attachmentId !== "number") {
      return {
        status: 400,
        jsonBody: { error: `${spec.parentParam} (number) and AttachmentID (number) required` },
      };
    }

    connection = await createConnection(token);
    await executeQuery(
      connection,
      `IF NOT EXISTS (
         SELECT 1 FROM ${spec.table}
          WHERE ${spec.parentColumn} = @ParentID AND AttachmentID = @AttachmentID
       )
       INSERT INTO ${spec.table} (${spec.parentColumn}, AttachmentID, AttachedBy)
       VALUES (@ParentID, @AttachmentID, @AttachedBy)`,
      [
        { name: "ParentID", type: TYPES.Int, value: parentId },
        { name: "AttachmentID", type: TYPES.Int, value: attachmentId },
        { name: "AttachedBy", type: TYPES.NVarChar, value: attachedBy },
      ],
    );
    return { status: 200, jsonBody: { ok: true } };
  } catch (error: any) {
    context.error(`attach (${spec.table}) failed:`, error.message);
    return errorResponse("Attach failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

async function detachFromParent(
  request: HttpRequest,
  context: InvocationContext,
  spec: JoinSpec,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const parentId = body?.[spec.parentParam];
    const attachmentId = body?.AttachmentID;
    if (typeof parentId !== "number" || typeof attachmentId !== "number") {
      return {
        status: 400,
        jsonBody: { error: `${spec.parentParam} (number) and AttachmentID (number) required` },
      };
    }

    connection = await createConnection(token);
    await executeQuery(
      connection,
      `DELETE FROM ${spec.table}
        WHERE ${spec.parentColumn} = @ParentID AND AttachmentID = @AttachmentID`,
      [
        { name: "ParentID", type: TYPES.Int, value: parentId },
        { name: "AttachmentID", type: TYPES.Int, value: attachmentId },
      ],
    );
    return { status: 200, jsonBody: { ok: true } };
  } catch (error: any) {
    context.error(`detach (${spec.table}) failed:`, error.message);
    return errorResponse("Detach failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

async function listParentAttachments(
  request: HttpRequest,
  context: InvocationContext,
  spec: JoinSpec,
  queryParam: string,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const raw = request.query.get(queryParam);
  if (!raw) {
    return { status: 400, jsonBody: { error: `${queryParam} is required` } };
  }
  const parentId = parseInt(raw, 10);
  if (!Number.isFinite(parentId)) {
    return { status: 400, jsonBody: { error: `${queryParam} must be a number` } };
  }

  let connection;
  try {
    connection = await createConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT a.*
         FROM ${spec.table} j
         JOIN Attachments a ON a.Id = j.AttachmentID
        WHERE j.${spec.parentColumn} = @ParentID
        ORDER BY j.AttachedAt DESC`,
      [{ name: "ParentID", type: TYPES.Int, value: parentId }],
    );
    const attachments = rows.map((r: any) => ({
      ...r,
      sasUrl: r.MyBuildingsConfirmedAt ? null : generateReadSasUrl(r.BlobName),
    }));
    return { status: 200, jsonBody: { attachments, count: attachments.length } };
  } catch (error: any) {
    context.error(`list (${spec.table}) failed:`, error.message);
    return errorResponse("Fetch failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/deleteAttachment ──────────────────────────────────────────────
// Body: { AttachmentID }. Deletes the local blob + the Attachments row;
// PurchaseOrderAttachments / QuoteAttachments rows are removed via the
// cascading FKs (see migration 010). Archived rows (MyBuildingsConfirmedAt
// set) keep no local blob, so the storage delete is skipped.

async function handleDeleteAttachment(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const attachmentId = body?.AttachmentID;
    if (typeof attachmentId !== "number") {
      return { status: 400, jsonBody: { error: "AttachmentID (number) required" } };
    }

    connection = await createConnection(token);
    const rows = await executeQuery(
      connection,
      "SELECT BlobName, MyBuildingsConfirmedAt FROM Attachments WHERE Id = @Id",
      [{ name: "Id", type: TYPES.Int, value: attachmentId }],
    );
    if (rows.length === 0) {
      return { status: 404, jsonBody: { error: "Attachment not found" } };
    }
    const blobName = rows[0].BlobName as string;
    const archived = rows[0].MyBuildingsConfirmedAt != null;

    if (!archived) {
      try {
        await deleteBlob(blobName);
      } catch (err: any) {
        // Don't fail the row delete if the blob is already gone — log and move on.
        context.warn(`deleteAttachment: blob delete failed for ${blobName}: ${err?.message}`);
      }
    }

    await executeQuery(
      connection,
      "DELETE FROM Attachments WHERE Id = @Id",
      [{ name: "Id", type: TYPES.Int, value: attachmentId }],
    );
    return { status: 200, jsonBody: { deleted: attachmentId } };
  } catch (error: any) {
    context.error("deleteAttachment failed:", error.message);
    return errorResponse("Delete failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("uploadAttachment", { methods: ["POST"], authLevel: "anonymous", handler: handleUploadAttachment });
app.http("getAttachments", { methods: ["GET"], authLevel: "anonymous", handler: handleGetAttachments });
app.http("deleteAttachment", { methods: ["POST"], authLevel: "anonymous", handler: handleDeleteAttachment });

app.http("attachToPurchaseOrder", {
  authLevel: "anonymous",
  handler: (req, ctx) => attachToParent(req, ctx, PO_JOIN),
  methods: ["POST"],
});
app.http("detachFromPurchaseOrder", {
  authLevel: "anonymous",
  handler: (req, ctx) => detachFromParent(req, ctx, PO_JOIN),
  methods: ["POST"],
});
app.http("getPurchaseOrderAttachments", {
  authLevel: "anonymous",
  handler: (req, ctx) => listParentAttachments(req, ctx, PO_JOIN, "purchaseOrderId"),
  methods: ["GET"],
});

app.http("attachToQuote", {
  authLevel: "anonymous",
  handler: (req, ctx) => attachToParent(req, ctx, QUOTE_JOIN),
  methods: ["POST"],
});
app.http("detachFromQuote", {
  authLevel: "anonymous",
  handler: (req, ctx) => detachFromParent(req, ctx, QUOTE_JOIN),
  methods: ["POST"],
});
app.http("getQuoteAttachments", {
  authLevel: "anonymous",
  handler: (req, ctx) => listParentAttachments(req, ctx, QUOTE_JOIN, "quoteId"),
  methods: ["GET"],
});
