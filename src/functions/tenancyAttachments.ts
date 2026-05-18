// ─────────────────────────────────────────────────────────────────────────────
// Tenancy document endpoints: upload + list.
//
// Documents (leases, schedules, amendments) are stored in blob storage and
// linked to a tenant via the TenancyAttachments join table (migration 056).
// No myBuildings push — tenancy docs are not work-request attachments.
// ─────────────────────────────────────────────────────────────────────────────

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { closeConnection, createConnection, executeQuery } from "../db";
import { extractToken, errorResponse, unauthorizedResponse } from "../auth";
import { generateReadSasUrl, uploadBlob } from "../blob-storage";
import { isAllowedContentType, MAX_SIZE_BYTES } from "../upload-constants";

// ── POST /api/uploadTenancyAttachment (multipart/form-data) ──────────────────
// Fields: file (binary), tenantId (number)
// Uploads the blob and creates an Attachments row linked via TenancyAttachments.

async function handleUploadTenancyAttachment(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const form = await request.formData();
    const file = form.get("file") as unknown as File | null;
    const tenantIdRaw = form.get("tenantId");
    const uploadedBy = form.get("uploadedBy")?.toString() ?? null;

    if (!file || typeof (file as any).arrayBuffer !== "function") {
      return { status: 400, jsonBody: { error: "Missing 'file' field in multipart body" } };
    }
    if (!tenantIdRaw) {
      return { status: 400, jsonBody: { error: "Missing 'tenantId' field" } };
    }

    const tenantId = parseInt(tenantIdRaw.toString(), 10);
    if (!Number.isFinite(tenantId)) {
      return { status: 400, jsonBody: { error: "'tenantId' must be a number" } };
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
    const extension = originalName.includes(".") ? originalName.split(".").pop() ?? null : null;
    const buffer = Buffer.from(await (file as any).arrayBuffer());

    context.log(`Uploading tenancy doc ${originalName} (${contentType}, ${size} bytes) for tenant ${tenantId}`);
    const { blobName } = await uploadBlob(buffer, originalName, contentType, `tenancy-${tenantId}`);
    const sasUrl = generateReadSasUrl(blobName);

    connection = await createConnection(token);

    const inserted = await executeQuery(
      connection,
      `INSERT INTO Attachments (BlobName, OriginalName, Extension, ContentType, SizeBytes, UploadedBy)
       OUTPUT INSERTED.*
       VALUES (@BlobName, @OriginalName, @Extension, @ContentType, @SizeBytes, @UploadedBy)`,
      [
        { name: "BlobName", type: TYPES.NVarChar, value: blobName },
        { name: "OriginalName", type: TYPES.NVarChar, value: originalName },
        { name: "Extension", type: TYPES.NVarChar, value: extension },
        { name: "ContentType", type: TYPES.NVarChar, value: contentType },
        { name: "SizeBytes", type: TYPES.BigInt, value: size },
        { name: "UploadedBy", type: TYPES.NVarChar, value: uploadedBy },
      ],
    );

    const row = inserted[0] as any;

    await executeQuery(
      connection,
      `INSERT INTO TenancyAttachments (TenantId, AttachmentID, AttachedBy)
       VALUES (@TenantId, @AttachmentID, @AttachedBy)`,
      [
        { name: "TenantId", type: TYPES.Int, value: tenantId },
        { name: "AttachmentID", type: TYPES.Int, value: row.Id },
        { name: "AttachedBy", type: TYPES.NVarChar, value: uploadedBy },
      ],
    );

    return { status: 200, jsonBody: { attachment: { ...row, sasUrl } } };
  } catch (error: any) {
    context.error("uploadTenancyAttachment failed:", error.message);
    return errorResponse("Upload failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── GET /api/getTenancyAttachments?tenantId=X ────────────────────────────────

async function handleGetTenancyAttachments(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const raw = request.query.get("tenantId");
  if (!raw) {
    return { status: 400, jsonBody: { error: "tenantId is required" } };
  }
  const tenantId = parseInt(raw, 10);
  if (!Number.isFinite(tenantId)) {
    return { status: 400, jsonBody: { error: "tenantId must be a number" } };
  }

  let connection;
  try {
    connection = await createConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT a.*
         FROM TenancyAttachments ta
         JOIN Attachments a ON a.Id = ta.AttachmentID
        WHERE ta.TenantId = @TenantId
        ORDER BY ta.AttachedAt DESC`,
      [{ name: "TenantId", type: TYPES.Int, value: tenantId }],
    );
    const attachments = rows.map((r: any) => ({
      ...r,
      sasUrl: r.MyBuildingsConfirmedAt ? null : generateReadSasUrl(r.BlobName),
    }));
    return { status: 200, jsonBody: { attachments, count: attachments.length } };
  } catch (error: any) {
    context.error("getTenancyAttachments failed:", error.message);
    return errorResponse("Fetch failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("uploadTenancyAttachment", {
  authLevel: "anonymous",
  handler: handleUploadTenancyAttachment,
  methods: ["POST"],
});

app.http("getTenancyAttachments", {
  authLevel: "anonymous",
  handler: handleGetTenancyAttachments,
  methods: ["GET"],
});
