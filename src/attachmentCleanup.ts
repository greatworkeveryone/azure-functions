// Rules for the daily attachment reap (functions/cleanupAttachments.ts).
//
// Our blob copy can only be dropped when myBuildings holds the file, and
// uploads are pushed there only when a work request exists. Job files with no
// work request, attachments claimed from email, and tenancy, asset and other
// documents live only in our container, so the reap is opt-in and limited to
// work-request rows. Inspection blobs stay excluded: raised jobs share them.

export function cleanupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ATTACHMENT_CLEANUP_ENABLED === "true";
}

export const CLEANUP_SELECT = `SELECT Id, BlobName, OriginalName, UploadedAt
       FROM Attachments
       WHERE MyBuildingsConfirmedAt IS NULL
         AND WorkRequestID IS NOT NULL
         AND UploadedAt < DATEADD(HOUR, -@GraceHours, SYSUTCDATETIME())
         AND BlobName NOT LIKE 'inspections/%'`;
