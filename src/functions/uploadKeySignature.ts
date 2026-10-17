// POST /api/uploadKeySignature   (multipart/form-data: file)
//
// The recipient's on-screen signature from the key check-out form, as a PNG.
// It is evidence of a handover, so like the handover photos it goes in the
// permanent `key-photos` container (never the transient wr-attachments one),
// with a row in dbo.Attachments (no work request, no job, so the attachment
// reaper never touches it) to hang an id on. The caller sends the returned
// attachmentId with checkoutKeys, which links it to the handover
// (KeyCheckoutBatches.SignatureAttachmentId). Response: { attachmentId }.
//
// This handler never deletes: if the database write fails the blob is left
// behind, which costs a few KB and loses nothing.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { closeConnection, createRequestConnection, executeQuery } from "../db";
import { errorResponse, extractToken, requireRole, unauthorizedResponse, verifiedIdentityFromRequest } from "../auth";
import { uploadKeyPhotoBlob } from "../blob-storage";
import { CHECKOUT_KEYS_ROLES } from "../keyRoles";
import { checkRateLimit } from "../rateLimit";

/** A drawn signature is a few KB; a megabyte is generous. */
export const MAX_SIGNATURE_BYTES = 1024 * 1024;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export async function uploadKeySignature(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, CHECKOUT_KEYS_ROLES);
  if (denied) return denied;

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  const limited = checkRateLimit(`uploadKeySignature:${identity.oid}`, { limit: 30, windowMs: 60_000 });
  if (!limited.allowed) {
    return {
      headers: { "Retry-After": String(Math.ceil(limited.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
      status: 429,
    };
  }

  let connection;
  try {
    const form = await request.formData();
    const file = form.get("file") as unknown as File | null;
    if (!file || typeof file.arrayBuffer !== "function") {
      return { jsonBody: { error: "Missing 'file' field in multipart body" }, status: 400 };
    }
    if (file.type !== "image/png") {
      return { jsonBody: { error: "A signature must be a PNG image" }, status: 415 };
    }
    if (file.size > MAX_SIGNATURE_BYTES) {
      return { jsonBody: { error: "That signature is too large" }, status: 413 };
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    if (!PNG_MAGIC.every((byte, i) => buffer[i] === byte)) {
      return { jsonBody: { error: "A signature must be a PNG image" }, status: 415 };
    }

    const originalName = "signature.png";
    const { blobName } = await uploadKeyPhotoBlob(buffer, originalName, "image/png");

    connection = await createRequestConnection(token);
    const inserted = await executeQuery(
      connection,
      `INSERT INTO dbo.Attachments (BlobName, OriginalName, Extension, ContentType, SizeBytes, UploadedBy)
       OUTPUT INSERTED.Id
       VALUES (@BlobName, @OriginalName, @Extension, @ContentType, @SizeBytes, @UploadedBy)`,
      [
        { name: "BlobName", type: TYPES.NVarChar, value: blobName },
        { name: "OriginalName", type: TYPES.NVarChar, value: originalName },
        { name: "Extension", type: TYPES.NVarChar, value: "png" },
        { name: "ContentType", type: TYPES.NVarChar, value: "image/png" },
        { name: "SizeBytes", type: TYPES.BigInt, value: buffer.length },
        { name: "UploadedBy", type: TYPES.NVarChar, value: identity.oid },
      ],
    );
    return { jsonBody: { attachmentId: inserted[0].Id as number }, status: 200 };
  } catch (error: any) {
    context.error("uploadKeySignature failed:", error.message);
    return errorResponse("Failed to save the signature", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("uploadKeySignature", {
  authLevel: "anonymous",
  handler: uploadKeySignature,
  methods: ["POST"],
});
