// ─────────────────────────────────────────────────────────────────────────────
// cleanupAttachments — daily timer that deletes blobs for attachments that
// were uploaded to myBuildings more than N hours ago and which we still hold
// in our blob container. Upload to myBuildings returned 2xx, so after the
// grace window we assume the file has been ingested on their side.
//
// We keep the SQL row (for audit + UI display) and stamp MyBuildingsConfirmedAt
// when we delete the blob. The frontend treats rows with a non-null
// MyBuildingsConfirmedAt as "archived — file no longer available locally".
// ─────────────────────────────────────────────────────────────────────────────

import { app, InvocationContext, Timer } from "@azure/functions";
import { TYPES } from "tedious";
import { closeConnection, createServiceConnection, executeQuery } from "../db";
import { deleteBlob } from "../blob-storage";

// Hours an attachment must age before we consider it safely ingested upstream.
const GRACE_HOURS = Number(process.env.ATTACHMENT_DELETE_GRACE_HOURS ?? "48");

async function runCleanup(context: InvocationContext): Promise<{ scanned: number; deleted: number; failed: number }> {
  const connection = await createServiceConnection();
  try {
    // Inspection-origin blobs are excluded: raiseJobsFromInspection copies only
    // the dbo.Attachments catalogue row and SHARES the blob with
    // dbo.InspectionAttachments (preserving the original UploadedAt), so
    // reaping them here would destroy photos the inspection still displays.
    const rows = await executeQuery(
      connection,
      `SELECT Id, BlobName, OriginalName, UploadedAt
       FROM Attachments
       WHERE MyBuildingsConfirmedAt IS NULL
         AND UploadedAt < DATEADD(HOUR, -@GraceHours, SYSUTCDATETIME())
         AND BlobName NOT LIKE 'inspections/%'`,
      [{ name: "GraceHours", type: TYPES.Int, value: GRACE_HOURS }],
    );

    let deleted = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        await deleteBlob(row.BlobName);
        await executeQuery(
          connection,
          "UPDATE Attachments SET MyBuildingsConfirmedAt=SYSUTCDATETIME() WHERE Id=@Id",
          [{ name: "Id", type: TYPES.Int, value: row.Id }],
        );
        context.log(`Deleted attachment #${row.Id} (${row.OriginalName}) uploaded ${row.UploadedAt}`);
        deleted++;
      } catch (err: any) {
        context.error(`Failed to delete attachment #${row.Id} (${row.BlobName}):`, err.message);
        failed++;
      }
    }

    return { deleted, failed, scanned: rows.length };
  } finally {
    closeConnection(connection);
  }
}

async function cleanupAttachmentsTimer(timer: Timer, context: InvocationContext): Promise<void> {
  if (timer.isPastDue) {
    context.warn("cleanupAttachments timer is past due — running now");
  }
  // Timers run with no user context, so authenticate to Azure SQL via the
  // service connection (managed identity → SQL access token). The previous
  // code mis-used MYBUILDINGS_BEARER_TOKEN — that's a static API key for
  // the myBuildings HTTP service, not an AAD SQL token.
  try {
    const { deleted, failed, scanned } = await runCleanup(context);
    context.log(`cleanupAttachments complete: scanned=${scanned}, deleted=${deleted}, failed=${failed}, graceHours=${GRACE_HOURS}`);
  } catch (error: any) {
    context.error("cleanupAttachments failed:", error.message);
  }
}

app.timer("cleanupAttachmentsTimer", {
  schedule: "0 0 3 * * *", // daily at 03:00 UTC
  handler: cleanupAttachmentsTimer,
});
