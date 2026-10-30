// Read-only report of tenant photo rows whose upload did not finish (TR3). Photos are reserved before the
// bytes are written (photos.ts), so a crash between the two leaves a 'reserved' row, and an upload that
// threw leaves a 'failed' one. Either may have a blob in tenant-quarantine with no row naming it; the Sha256
// and the request id let storage be searched for it. This only reads: nothing is deleted or changed here.

import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../db";
import { RESERVATION_MINUTES } from "./photos";

export interface OrphanPhotoApi {
  contentType: string;
  photoId: number;
  sha256: string;
  sizeBytes: number;
  state: string;
  tenantId: number;
  uploadedAt: string | null;
  workRequestId: number;
}

export async function orphanPhotoReport(connection: Connection, limit = 200): Promise<OrphanPhotoApi[]> {
  const rows = await executeQuery(
    connection,
    `SELECT TOP (@Limit) PhotoId, WorkRequestID, TenantId, ContentType, SizeBytes, Sha256, UploadState, UploadedAt
       FROM dbo.TenantRequestPhotos
      WHERE UploadState = N'failed' OR (UploadState = N'reserved' AND UploadedAt <= DATEADD(MINUTE, -${RESERVATION_MINUTES}, SYSUTCDATETIME()))
      ORDER BY UploadedAt DESC`,
    [{ name: "Limit", type: TYPES.Int, value: Math.min(Math.max(limit, 1), 1000) }],
  );
  return rows.map((r) => ({
    contentType: String(r.ContentType),
    photoId: Number(r.PhotoId),
    sha256: Buffer.isBuffer(r.Sha256) ? r.Sha256.toString("hex") : "",
    sizeBytes: Number(r.SizeBytes),
    state: String(r.UploadState),
    tenantId: Number(r.TenantId),
    uploadedAt: r.UploadedAt instanceof Date ? r.UploadedAt.toISOString() : null,
    workRequestId: Number(r.WorkRequestID),
  }));
}
