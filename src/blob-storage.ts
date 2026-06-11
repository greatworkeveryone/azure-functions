// ─────────────────────────────────────────────────────────────────────────────
// Blob-storage helpers for work-request attachments.
// Container is created on first use. SAS URLs are short-lived read tokens so
// myBuildings can ingest the file without us exposing the blob publicly.
// ─────────────────────────────────────────────────────────────────────────────

import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  SASProtocol,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import { randomUUID } from "crypto";

const CONTAINER_NAME = process.env.ATTACHMENTS_CONTAINER_NAME ?? "wr-attachments";
const SAS_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

let cachedServiceClient: BlobServiceClient | undefined;
let cachedAccountKey: StorageSharedKeyCredential | undefined;

function getServiceClient(): BlobServiceClient {
  if (cachedServiceClient) return cachedServiceClient;
  const connStr = process.env.AzureWebJobsStorage;
  if (!connStr) {
    throw new Error("AzureWebJobsStorage connection string is not configured");
  }
  cachedServiceClient = BlobServiceClient.fromConnectionString(connStr);
  // Reuse the credential the SDK constructed from the connection string —
  // hand-rolling our own risks key drift (e.g. wrong well-known Azurite key).
  const cred = (cachedServiceClient as unknown as { credential?: unknown }).credential;
  if (cred instanceof StorageSharedKeyCredential) {
    cachedAccountKey = cred;
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
 * Generates a time-limited read SAS URL for a blob in the given container.
 * TTL is 4 hours by default. Used both to hand files to myBuildings for ingest
 * and to surface privately-stored vacancy / building-gallery images to clients.
 */
function generateReadSasUrlForContainer(
  containerName: string,
  blobName: string,
  ttlMs: number,
): string {
  const service = getServiceClient();
  if (!cachedAccountKey) {
    throw new Error("Blob account key unavailable — SAS signing requires a shared-key connection string");
  }
  const expiresOn = new Date(Date.now() + ttlMs);
  const isDevStorage = service.url.startsWith("http://");
  const sas = generateBlobSASQueryParameters(
    {
      blobName,
      containerName,
      expiresOn,
      permissions: BlobSASPermissions.parse("r"),
      protocol: isDevStorage ? SASProtocol.HttpsAndHttp : SASProtocol.Https,
      // Azurite only knows how to validate signatures for older API versions.
      // Pin SAS version on dev storage; let SDK default apply in prod.
      ...(isDevStorage ? { version: "2024-08-04" } : {}),
    },
    cachedAccountKey,
  ).toString();
  const base = service.url.endsWith("/") ? service.url : `${service.url}/`;
  return `${base}${containerName}/${blobName}?${sas}`;
}

/**
 * Generates a time-limited read SAS URL for a work-request attachment blob.
 * TTL is 4 hours by default; the URL is handed to myBuildings so their server
 * can ingest the file.
 */
export function generateReadSasUrl(blobName: string, ttlMs: number = SAS_TTL_MS): string {
  return generateReadSasUrlForContainer(CONTAINER_NAME, blobName, ttlMs);
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
export async function downloadBlob(blobName: string): Promise<Buffer> {
  const container = await getContainerClient();
  const blockBlob = container.getBlockBlobClient(blobName);
  const response = await blockBlob.downloadToBuffer();
  return response;
}

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

// ─────────────────────────────────────────────────────────────────────────────
// Blob helpers for vacancy / building-gallery images.
//
// The container is PRIVATE. We previously created it with `access: "blob"`
// (container-level anonymous read) so WordPress could reference the URLs
// directly, but storage accounts default to disallowing public access, which
// made `createIfNotExists({ access: "blob" })` throw `PublicAccessNotPermitted`
// (surfaced to the UI as a generic 500). Instead we store the bare blob URL in
// the DB and mint a short-lived read SAS at the read boundary so the app can
// display images without the account allowing anonymous access.
//
// NOTE (WordPress trade-off): SAS URLs expire (4h default). The publish flow is
// unaffected because `uploadImageToWp` fetches each image SERVER-SIDE at publish
// time and re-uploads it into the WordPress media library (WP keeps its own
// copy), so an expiring SAS is fine for that one-time ingest. If any consumer
// ever needs a NON-expiring public URL, that requires an infra decision
// (account-level public access + container ACL, or a long-lived SAS) — it is
// intentionally NOT re-enabled here.
// ─────────────────────────────────────────────────────────────────────────────

const VACANCIES_CONTAINER = "vacancies";
// Vacancy/gallery read SAS — longer-lived than the 4h attachment TTL so a page
// left open doesn't get broken images mid-session, but still bounded.
const VACANCY_SAS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function getVacanciesContainerClient() {
  const container = getServiceClient().getContainerClient(VACANCIES_CONTAINER);
  // Private by default — no `access` option. Does not require the storage
  // account to permit anonymous public access.
  await container.createIfNotExists();
  return container;
}

export async function uploadPublicBlob(
  buffer: Buffer,
  originalName: string,
  contentType: string,
  keyPrefix: string,
): Promise<{ blobName: string; url: string }> {
  const container = await getVacanciesContainerClient();
  const ext = originalName.includes(".") ? originalName.split(".").pop() : "";
  const blobName = `${keyPrefix}/${randomUUID()}${ext ? "." + ext : ""}`;
  const blockBlob = container.getBlockBlobClient(blobName);
  await blockBlob.uploadData(buffer, {
    blobHTTPHeaders: { blobContentType: contentType },
  });
  return { blobName, url: blockBlob.url };
}

export async function deletePublicBlob(blobName: string): Promise<void> {
  const container = await getVacanciesContainerClient();
  await container.getBlockBlobClient(blobName).deleteIfExists();
}

/**
 * Extracts the blob name from a bare vacancies-container URL (the form stored in
 * the DB). Returns null if the URL doesn't point at the vacancies container —
 * e.g. an already-SAS'd URL is passed back through, or an external CDN URL.
 */
export function vacanciesBlobNameFromUrl(url: string): string | null {
  if (typeof url !== "string" || url.length === 0) return null;
  const marker = `/${VACANCIES_CONTAINER}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  // Strip any existing query string (defensive — stored values are bare).
  const after = url.slice(idx + marker.length);
  const q = after.indexOf("?");
  return q === -1 ? after : after.slice(0, q);
}

/**
 * Converts a bare vacancies-container blob URL (as persisted in the DB) into a
 * short-lived read SAS URL the client can load directly. Non-vacancies-container
 * URLs (external CDN, already-signed, etc.) are returned unchanged so callers
 * can map over mixed lists safely.
 */
export function vacanciesReadSasUrl(
  url: string,
  ttlMs: number = VACANCY_SAS_TTL_MS,
): string {
  const blobName = vacanciesBlobNameFromUrl(url);
  if (!blobName) return url;
  return generateReadSasUrlForContainer(VACANCIES_CONTAINER, blobName, ttlMs);
}
