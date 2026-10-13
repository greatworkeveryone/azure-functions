// ─────────────────────────────────────────────────────────────────────────────
// cleanupAttachments — daily timer that deletes our blob copy of attachments
// pushed to myBuildings (work-request rows only) more than N hours ago. Off
// unless ATTACHMENT_CLEANUP_ENABLED=true; the rules live in attachmentCleanup.ts.
//
// We keep the SQL row (for audit + UI display) and stamp MyBuildingsConfirmedAt
// when we delete the blob. The frontend treats rows with a non-null
// MyBuildingsConfirmedAt as "archived — file no longer available locally".
// ─────────────────────────────────────────────────────────────────────────────

import { app, InvocationContext, Timer } from "@azure/functions";
import { TYPES } from "tedious";
import { closeConnection, createServiceConnection, executeQuery } from "../db";
import { CLEANUP_SELECT, cleanupEnabled } from "../attachmentCleanup";
import { deleteBlob } from "../blob-storage";

// Hours an attachment must age before we consider it safely ingested upstream.
const GRACE_HOURS = Number(process.env.ATTACHMENT_DELETE_GRACE_HOURS ?? "48");

async function runCleanup(context: InvocationContext): Promise<{ scanned: number; deleted: number; failed: number }> {
  const connection = await createServiceConnection();
  try {
    const rows = await executeQuery(
      connection,
      CLEANUP_SELECT,
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
  if (!cleanupEnabled()) {
    context.log("cleanupAttachments disabled (ATTACHMENT_CLEANUP_ENABLED is not \"true\") — nothing deleted");
    return;
  }
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
