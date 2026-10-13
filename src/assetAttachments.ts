// Attachments linked to an asset (dbo.AssetAttachments over dbo.Attachments),
// with a read SAS minted per file. Shared by getAsset and getAssetAttachments.
// Kept out of assetRegisterSupport so only the handlers that serve files load
// the blob-storage SDK.

import { TYPES } from "tedious";
import type { Connection } from "tedious";
import { executeQuery } from "./db";
import { generateReadSasUrl } from "./blob-storage";
import { AssetAttachmentApi, attachmentRowToApi } from "./assetRegister";

const ASSET_ATTACHMENT_COLUMNS = `
  att.Id, aa.AssetId, att.BlobName, att.OriginalName, att.Extension, att.ContentType,
  att.SizeBytes, att.Comment, att.UploadedBy, u.DisplayName AS UploadedByName,
  att.UploadedAt, att.MyBuildingsConfirmedAt, aa.AttachedAt
`;

/** Newest first. UploadedBy holds an Entra oid (as everywhere else), resolved to a name via AppUsers. */
export async function fetchAssetAttachments(
  connection: Connection,
  assetId: number,
): Promise<AssetAttachmentApi[]> {
  const rows = await executeQuery(
    connection,
    `SELECT ${ASSET_ATTACHMENT_COLUMNS}
       FROM dbo.AssetAttachments aa
       JOIN dbo.Attachments att ON att.Id = aa.AttachmentID
       LEFT JOIN dbo.AppUsers u ON u.EntraOid = att.UploadedBy
      WHERE aa.AssetId = @AssetId
      ORDER BY aa.AttachedAt DESC, att.Id DESC`,
    [{ name: "AssetId", type: TYPES.Int, value: assetId }],
  );
  return rows.map((row) =>
    attachmentRowToApi(row, row.MyBuildingsConfirmedAt ? null : generateReadSasUrl(String(row.BlobName))),
  );
}
