import { TYPES, type Connection } from "tedious";
import { executeQuery } from "./db";
import { isBlobName, WR_ATTACHMENTS_SHAPES } from "./blob-names";

export const PDF_NOT_A_JOB_ATTACHMENT = "The PDF must be one of this job's attachments";

/**
 * Quote and invoice PDF names arrive in the request body and are later
 * downloaded server-side into the director packet (SEC-01 path C). A name is
 * accepted only when it is a minted wr-attachments name that an Attachments
 * row on the same job already carries.
 */
export async function isJobAttachmentBlob(
  connection: Connection,
  jobId: number,
  blobName: unknown,
): Promise<boolean> {
  if (!isBlobName(blobName, WR_ATTACHMENTS_SHAPES)) return false;
  const rows = await executeQuery(
    connection,
    `SELECT TOP 1 Id FROM Attachments WHERE JobID = @JobID AND BlobName = @BlobName`,
    [
      { name: "JobID", type: TYPES.Int, value: jobId },
      { name: "BlobName", type: TYPES.NVarChar, value: blobName },
    ],
  );
  return rows.length > 0;
}
