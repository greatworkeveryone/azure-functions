// A photo for a request this tenancy has just made (TR3). Raw image bytes in the body, one photo per
// call, at most five per request. The photo can only be attached to a request that belongs to the
// resolved tenancy (SourceTenantId) and was submitted within the last two hours; the request id comes
// from the client but is only ever a lookup key INSIDE the tenancy's own requests.
//
// Order: the photo's row is reserved under the lock first (state 'reserved'), then the bytes are uploaded,
// then the row is marked 'stored' with the real blob name. An upload that fails marks the row 'failed' and
// frees the slot; one that dies mid-way leaves a 'reserved' row that orphanReport.ts lists (never deleted).
//
// Storage: the bytes pass magic-byte and structure checks (imageSniff.ts), then go UNCHANGED to the
// private tenant-quarantine container marked processed=false. They are not decoded or re-encoded: no
// image library exists in this backend and none may be added without review. Nothing serves them.

import { createHash, randomUUID } from "node:crypto";
import { TYPES, type Connection } from "tedious";
import { uploadTenantQuarantineBlob } from "../blob-storage";
import { beginTransaction, commitTransaction, executeQuery, rollbackTransaction } from "../db";
import { record } from "../ledger";
import type { TenantLinkIdentity } from "../tenantLinks/types";
import { LIMITS } from "./constants";
import { sniffImage, type ImageType } from "./imageSniff";
import { referenceFor } from "./list";

export type PhotoResult =
  | { ok: true; photoCount: number; reference: string }
  | { error: string; ok: false; status: 404 | 409 | 413 | 415 | 429 };

/** Content-Type values a client may send; the sniffed type is what is stored, and must agree. */
const DECLARED: Record<ImageType, string> = { "image/jpeg": "image/jpeg", "image/png": "image/png", "image/webp": "image/webp" };

export function parseRequestId(header: string | null): number | null {
  if (header === null || !/^-[1-9][0-9]{0,9}$/.test(header.trim())) return null;
  const id = Number(header.trim());
  return Number.isSafeInteger(id) && id >= -2_147_483_648 ? id : null;
}

/** A reserved row older than this has probably lost its upload; it stops counting toward the caps. */
export const RESERVATION_MINUTES = 15;
const COUNTING = `(UploadState = N'stored' OR (UploadState = N'reserved' AND UploadedAt > DATEADD(MINUTE, -${RESERVATION_MINUTES}, SYSUTCDATETIME())))`;
const COUNT_LOCKED_SQL = `SELECT COUNT(*) AS N FROM dbo.TenantRequestPhotos WITH (UPDLOCK, HOLDLOCK) WHERE WorkRequestID = @Id AND TenantId = @TenantId AND ${COUNTING}`;
const TODAY_SQL = `SELECT COUNT(*) AS N FROM dbo.TenantRequestPhotos WHERE TenantId = @TenantId AND ${COUNTING} AND UploadedAt > DATEADD(HOUR, -24, SYSUTCDATETIME())`;

export async function storePhoto(
  connection: Connection,
  identity: TenantLinkIdentity,
  requestId: number,
  bytes: Buffer,
  declaredType: string,
): Promise<PhotoResult> {
  if (bytes.length === 0 || bytes.length > LIMITS.photoBytes) return { error: "That photo is too large", ok: false, status: 413 };
  const sniffed = sniffImage(bytes);
  if (sniffed === null || DECLARED[sniffed] !== declaredType.split(";")[0].trim().toLowerCase()) {
    return { error: "Only JPEG, PNG or WebP photos can be added", ok: false, status: 415 };
  }
  const params = [
    { name: "Id", type: TYPES.Int, value: requestId },
    { name: "TenantId", type: TYPES.Int, value: identity.tenantId },
  ];
  const [owned] = await executeQuery(
    connection,
    `SELECT WorkRequestID FROM dbo.WorkRequests WHERE WorkRequestID = @Id AND SourceTenantId = @TenantId AND SourceKind = N'tenant_link'
        AND CreatedAt > DATEADD(HOUR, -@Hours, GETUTCDATE())`,
    [...params, { name: "Hours", type: TYPES.Int, value: LIMITS.photoWindowHours }],
  );
  if (!owned) return { error: "request_not_found", ok: false, status: 404 };

  // Reserve the slot under the lock BEFORE any bytes are uploaded, so parallel uploads cannot each pass an
  // unlocked count and leave blobs that count toward no cap. The row is the claim; the blob follows.
  let photoId: number;
  let slotsUsed: number;
  await beginTransaction(connection);
  try {
    const [again] = await executeQuery(connection, COUNT_LOCKED_SQL, params);
    if (Number(again?.N ?? 0) >= LIMITS.maxPhotosPerRequest) {
      await rollbackTransaction(connection);
      return { error: "A request can have up to five photos", ok: false, status: 409 };
    }
    const [today] = await executeQuery(connection, TODAY_SQL, [params[1]]);
    if (Number(today?.N ?? 0) >= LIMITS.photosPerTenancyPerDay) {
      await rollbackTransaction(connection);
      return { error: "rate_limited", ok: false, status: 429 };
    }
    const [reserved] = await executeQuery(
      connection,
      `INSERT INTO dbo.TenantRequestPhotos (WorkRequestID, TenantId, ContactId, BlobName, ContentType, SizeBytes, Sha256, Processed, UploadState)
       OUTPUT INSERTED.PhotoId
       VALUES (@Id, @TenantId, @ContactId, @BlobName, @ContentType, @Size, @Sha, 0, N'reserved')`,
      [
        ...params,
        { name: "ContactId", type: TYPES.Int, value: identity.contactId },
        { name: "BlobName", type: TYPES.NVarChar, value: `pending:${randomUUID()}` },
        { name: "ContentType", type: TYPES.NVarChar, value: sniffed },
        { name: "Size", type: TYPES.BigInt, value: bytes.length },
        { name: "Sha", type: TYPES.Binary, value: createHash("sha256").update(bytes).digest() },
      ],
    );
    photoId = Number(reserved?.PhotoId);
    slotsUsed = Number(again?.N ?? 0) + 1;
    await commitTransaction(connection);
  } catch (error) {
    await rollbackTransaction(connection).catch(() => undefined);
    throw error;
  }

  let blobName: string;
  try {
    blobName = (await uploadTenantQuarantineBlob(bytes, sniffed, requestId)).blobName;
  } catch (error) {
    await executeQuery(connection, `UPDATE dbo.TenantRequestPhotos SET UploadState = N'failed' WHERE PhotoId = @PhotoId`, [
      { name: "PhotoId", type: TYPES.Int, value: photoId },
    ]).catch(() => undefined);
    throw error;
  }
  await beginTransaction(connection);
  try {
    await executeQuery(connection, `UPDATE dbo.TenantRequestPhotos SET UploadState = N'stored', BlobName = @BlobName WHERE PhotoId = @PhotoId`, [
      { name: "PhotoId", type: TYPES.Int, value: photoId },
      { name: "BlobName", type: TYPES.NVarChar, value: blobName },
    ]);
    await record(connection, {
      action: "tenancy.request_photo",
      actor: { kind: "system", name: "tenantPage" },
      after: { bytes: bytes.length, contactId: identity.contactId, processed: false, reference: referenceFor(requestId), type: sniffed },
      buildingId: identity.buildingId,
      subject: { id: identity.tenantId, type: "tenancy" },
      tenantId: identity.tenantId,
    });
    await commitTransaction(connection);
    return { ok: true, photoCount: slotsUsed, reference: referenceFor(requestId) };
  } catch (error) {
    await rollbackTransaction(connection).catch(() => undefined);
    throw error;
  }
}
