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
import { generateReadSasUrl, uploadBlob } from "../blob-storage";
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

async function handleUploadAttachment(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const form = await request.formData();
    const file = form.get("file") as unknown as File | null;
    const workRequestIdRaw = form.get("workRequestId");
    const jobCode = form.get("jobCode")?.toString() ?? null;
    const uploadedBy = form.get("uploadedBy")?.toString() ?? null;

    if (!file || typeof (file as any).arrayBuffer !== "function") {
      return { status: 400, jsonBody: { error: "Missing 'file' field in multipart body" } };
    }
    if (!workRequestIdRaw) {
      return { status: 400, jsonBody: { error: "Missing 'workRequestId' field" } };
    }

    const workRequestId = parseInt(workRequestIdRaw.toString(), 10);
    if (!Number.isFinite(workRequestId)) {
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

    context.log(`Uploading ${originalName} (${contentType}, ${size} bytes) for WR ${workRequestId}`);
    const { blobName } = await uploadBlob(buffer, originalName, contentType, workRequestId);
    const sasUrl = generateReadSasUrl(blobName);

    // Hand the SAS URL to myBuildings; they ingest server-side
    const extension = originalName.includes(".") ? originalName.split(".").pop() ?? "" : "";
    await uploadAttachment({
      Attachment_Extension: extension,
      Attachment_Name: originalName,
      Attachment_URL: sasUrl,
      JobCode: jobCode ?? undefined,
      WorkRequestID: workRequestId,
    });

    // Record locally
    connection = await createConnection(token);
    const inserted = await executeQuery(
      connection,
      `INSERT INTO Attachments (WorkRequestID, JobCode, BlobName, OriginalName, Extension, ContentType, SizeBytes, UploadedBy)
       OUTPUT INSERTED.*
       VALUES (@WorkRequestID, @JobCode, @BlobName, @OriginalName, @Extension, @ContentType, @SizeBytes, @UploadedBy)`,
      [
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

// ── GET /api/getAttachments?workRequestId=X ──────────────────────────────────

async function handleGetAttachments(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const workRequestIdRaw = request.query.get("workRequestId");
  if (!workRequestIdRaw) {
    return { status: 400, jsonBody: { error: "workRequestId is required" } };
  }
  const workRequestId = parseInt(workRequestIdRaw, 10);
  if (!Number.isFinite(workRequestId)) {
    return { status: 400, jsonBody: { error: "workRequestId must be a number" } };
  }

  let connection;
  try {
    connection = await createConnection(token);
    const rows = await executeQuery(
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

app.http("uploadAttachment", { methods: ["POST"], authLevel: "anonymous", handler: handleUploadAttachment });
app.http("getAttachments", { methods: ["GET"], authLevel: "anonymous", handler: handleGetAttachments });
