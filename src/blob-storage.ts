// ─────────────────────────────────────────────────────────────────────────────
// Blob-storage helpers for work-request attachments.
// Container is created on first use. SAS URLs are short-lived read tokens so
// myBuildings can ingest the file without us exposing the blob publicly.
// ─────────────────────────────────────────────────────────────────────────────

import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import { randomUUID } from "crypto";

const CONTAINER_NAME = process.env.ATTACHMENTS_CONTAINER_NAME ?? "wr-attachments";
const SAS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let cachedServiceClient: BlobServiceClient | undefined;
let cachedAccountKey: StorageSharedKeyCredential | undefined;

function parseConnectionString(connStr: string): { accountName: string; accountKey: string } {
  const parts = Object.fromEntries(
    connStr.split(";").filter(Boolean).map((pair) => {
      const idx = pair.indexOf("=");
      return [pair.slice(0, idx), pair.slice(idx + 1)];
    }),
  );
  return {
    accountName: parts.AccountName,
    accountKey: parts.AccountKey,
  };
}

function getServiceClient(): BlobServiceClient {
  if (cachedServiceClient) return cachedServiceClient;
  const connStr = process.env.AzureWebJobsStorage;
  if (!connStr) {
    throw new Error("AzureWebJobsStorage connection string is not configured");
  }
  cachedServiceClient = BlobServiceClient.fromConnectionString(connStr);
  const { accountName, accountKey } = parseConnectionString(connStr);
  if (accountName && accountKey) {
    cachedAccountKey = new StorageSharedKeyCredential(accountName, accountKey);
  }
  return cachedServiceClient;
}

async function getContainerClient() {
  const container = getServiceClient().getContainerClient(CONTAINER_NAME);
  await container.createIfNotExists(); // private by default
  return container;
}

export interface UploadBlobResult {
  blobName: string;
  url: string; // account URL of the blob (no SAS yet)
}

export async function uploadBlob(
  buffer: Buffer,
  originalName: string,
  contentType: string,
  keyPrefix: string,
): Promise<UploadBlobResult> {
  const container = await getContainerClient();
  const ext = originalName.includes(".") ? originalName.split(".").pop() : "";
  const blobName = `${keyPrefix}/${randomUUID()}${ext ? "." + ext : ""}`;
  const blockBlob = container.getBlockBlobClient(blobName);
  await blockBlob.uploadData(buffer, {
    blobHTTPHeaders: {
      blobContentType: contentType,
      blobContentDisposition: `inline; filename="${encodeURIComponent(originalName)}"`,
    },
  });
  return { blobName, url: blockBlob.url };
}

/**
 * Generates a time-limited read SAS URL for a blob. TTL is 7 days by default;
 * the URL is handed to myBuildings so their server can ingest the file.
 */
export function generateReadSasUrl(blobName: string, ttlMs: number = SAS_TTL_MS): string {
  const service = getServiceClient();
  if (!cachedAccountKey) {
    throw new Error("Blob account key unavailable — SAS signing requires a shared-key connection string");
  }
  const expiresOn = new Date(Date.now() + ttlMs);
  const sas = generateBlobSASQueryParameters(
    {
      blobName,
      containerName: CONTAINER_NAME,
      expiresOn,
      permissions: BlobSASPermissions.parse("r"),
      protocol: "https" as any,
    },
    cachedAccountKey,
  ).toString();
  return `${service.url}${CONTAINER_NAME}/${blobName}?${sas}`;
}

export async function deleteBlob(blobName: string): Promise<void> {
  const container = await getContainerClient();
  await container.getBlockBlobClient(blobName).deleteIfExists();
}

/**
 * Uploads a rendered Purchase Order PDF under a deterministic key
 * (`po/{poId}.pdf`), so re-previewing overwrites the same blob rather than
 * leaving orphaned drafts. Returns the blob name for storage on the PO row.
 */
export async function uploadPurchaseOrderPdf(
  purchaseOrderId: number,
  buffer: Buffer,
): Promise<UploadBlobResult> {
  const container = await getContainerClient();
  const blobName = `po/${purchaseOrderId}.pdf`;
  const blockBlob = container.getBlockBlobClient(blobName);
  await blockBlob.uploadData(buffer, {
    blobHTTPHeaders: {
      blobContentType: "application/pdf",
      blobContentDisposition: `inline; filename="${blobName.replace(/^po\//, "")}"`,
    },
  });
  return { blobName, url: blockBlob.url };
}
