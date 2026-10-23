// POST /api/uploadAssetAttachment   (multipart/form-data: file, assetId)
//
// Same path as uploadTenancyAttachment - private blob, Attachments row, junction
// row - except that both rows are written in one transaction and the blob is
// removed again if either fails. The asset must exist and be live (checked
// BEFORE the upload so a rejected request never leaves a blob behind).
// Blobs are keyed asset-<id>/...; the removed cleanup timer only reaped work-request
// rows, and these never carry a work request.
// Response: { attachment } (AssetAttachmentApi, with sasUrl).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import type { Connection } from "tedious";
import { closeConnection, createRequestConnection, executeQuery } from "../db";
import { errorResponse } from "../auth";
import { deleteBlob, generateReadSasUrl, uploadBlob } from "../blob-storage";
import { checkRateLimit } from "../rateLimit";
import { bytesMatchMediaType, isAllowedContentType, MAX_SIZE_BYTES, normaliseMediaType } from "../upload-constants";
import { ASSET_BLOB_PREFIX, EDIT_ASSETS_ROLES, attachmentRowToApi, parseQueryInt } from "../assetRegister";
import {
  authorizeWrite,
  badRequest,
  conflict,
  errorMessage,
  inTransaction,
  notFound,
  txOk,
} from "../assetRegisterSupport";

const UPLOAD_RATE_LIMIT = { limit: 30, windowMs: 60_000 };

export async function uploadAssetAttachment(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, EDIT_ASSETS_ROLES);
  if (!auth.ok) return auth.response;

  const limited = checkRateLimit(`uploadAssetAttachment:${auth.caller.oid}`, UPLOAD_RATE_LIMIT);
  if (!limited.allowed) {
    return {
      headers: { "Retry-After": String(Math.ceil(limited.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
      status: 429,
    };
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return badRequest("Request must be multipart/form-data");
  }
  const file = form.get("file") as unknown as File | null;
  if (!file || typeof file.arrayBuffer !== "function") {
    return badRequest("Missing 'file' field in multipart body");
  }
  const assetIdRaw = form.get("assetId");
  const assetId = parseQueryInt(assetIdRaw === null ? null : String(assetIdRaw), "assetId");
  if (!assetId.ok) return badRequest(assetId.error);
  if (assetId.value === undefined || assetId.value < 1) return badRequest("Missing 'assetId' field");

  const contentType = normaliseMediaType(file.type || "") || "application/octet-stream"; // stored form, never the raw header
  if (!isAllowedContentType(contentType)) {
    return { jsonBody: { error: `File type '${contentType}' is not allowed` }, status: 415 };
  }
  if (file.size > MAX_SIZE_BYTES) {
    return {
      jsonBody: { error: `File exceeds ${MAX_SIZE_BYTES / 1024 / 1024} MB limit` },
      status: 413,
    };
  }

  const originalName = file.name;
  const extension = originalName.includes(".") ? (originalName.split(".").pop() ?? null) : null;

  let connection: Connection | undefined;
  let blobName: string | null = null;
  try {
    connection = await createRequestConnection(auth.token);
    const conn = connection;

    const assets = await executeQuery(
      conn,
      `SELECT AssetId, ArchivedAt FROM dbo.Assets WHERE AssetId = @AssetId`,
      [{ name: "AssetId", type: TYPES.Int, value: assetId.value }],
    );
    if (!assets[0]) return notFound("Asset not found");
    if (assets[0].ArchivedAt) return conflict("Archived assets cannot take new attachments");

    context.log(`Uploading asset file ${originalName} (${contentType}, ${file.size} bytes) for asset ${assetId.value}`);
    const buffer = Buffer.from(await file.arrayBuffer());
    if (!bytesMatchMediaType(contentType, buffer)) {
      return { status: 415, jsonBody: { error: "File contents do not match its declared type" } };
    }
    const uploaded = await uploadBlob(buffer, originalName, contentType, `${ASSET_BLOB_PREFIX}${assetId.value}`);
    blobName = uploaded.blobName;
    const storedBlobName = uploaded.blobName;

    const outcome = await inTransaction(conn, async () => {
      const attachment = await executeQuery(
        conn,
        `INSERT INTO dbo.Attachments (BlobName, OriginalName, Extension, ContentType, SizeBytes, UploadedBy)
         OUTPUT INSERTED.Id, INSERTED.UploadedAt
         VALUES (@BlobName, @OriginalName, @Extension, @ContentType, @SizeBytes, @UploadedBy)`,
        [
          { name: "BlobName", type: TYPES.NVarChar, value: storedBlobName },
          { name: "OriginalName", type: TYPES.NVarChar, value: originalName },
          { name: "Extension", type: TYPES.NVarChar, value: extension },
          { name: "ContentType", type: TYPES.NVarChar, value: contentType },
          { name: "SizeBytes", type: TYPES.BigInt, value: file.size },
          { name: "UploadedBy", type: TYPES.NVarChar, value: auth.caller.oid },
        ],
      );
      const linked = await executeQuery(
        conn,
        `INSERT INTO dbo.AssetAttachments (AssetId, AttachmentID, AttachedBy)
         OUTPUT INSERTED.AttachedAt
         VALUES (@AssetId, @AttachmentID, @AttachedBy)`,
        [
          { name: "AssetId", type: TYPES.Int, value: assetId.value },
          { name: "AttachmentID", type: TYPES.Int, value: attachment[0].Id },
          { name: "AttachedBy", type: TYPES.NVarChar, value: auth.caller.oid },
        ],
      );
      return txOk(
        attachmentRowToApi(
          {
            AssetId: assetId.value,
            AttachedAt: linked[0].AttachedAt,
            Comment: null,
            ContentType: contentType,
            Extension: extension,
            Id: attachment[0].Id,
            OriginalName: originalName,
            SizeBytes: file.size,
            UploadedAt: attachment[0].UploadedAt,
            UploadedBy: auth.caller.oid,
            UploadedByName: auth.caller.name,
          },
          generateReadSasUrl(storedBlobName),
        ),
      );
    });
    if (!outcome.ok) return outcome.response;
    return { jsonBody: { attachment: outcome.value }, status: 200 };
  } catch (error) {
    // The file is orphaned if the database write (or anything after the upload) failed.
    if (blobName) await deleteBlob(blobName).catch(() => undefined);
    context.error("uploadAssetAttachment failed:", errorMessage(error));
    return errorResponse("Upload failed", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("uploadAssetAttachment", {
  authLevel: "anonymous",
  handler: uploadAssetAttachment,
  methods: ["POST"],
});
