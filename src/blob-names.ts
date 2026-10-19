// ─────────────────────────────────────────────────────────────────────────────
// Blob-name shapes (SEC-01).
//
// The storage SDK resolves "." and ".." segments when it builds a blob URL and
// signs the request for the normalised path, so a name such as
// `email-attachments/x/../../key-photos/keys/a.jpg` addresses another
// container. Blob names are minted server-side; every name that reaches a
// delete, a download or a SAS must match the exact shape minted for its
// container. Anything else is refused before the SDK sees it.
// ─────────────────────────────────────────────────────────────────────────────

export class BlobNameError extends Error {
  constructor(reason: string) {
    super(`Rejected blob name (${reason})`);
    this.name = "BlobNameError";
  }
}

export interface BlobNameShape {
  readonly label: string;
  readonly pattern: RegExp;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// sanitizeBlobExtension() reduces every extension to ≤10 alphanumerics.
const EXT = "(?:\\.[A-Za-z0-9]{1,10})?";
const MAX_NAME_LENGTH = 1024;

function uuidLeafUnder(label: string, prefix: string): BlobNameShape {
  return { label, pattern: new RegExp(`^${prefix}\\/${UUID}${EXT}$`) };
}

/**
 * Files a single record owns in `wr-attachments`: job and work-request uploads,
 * tenancy and asset files, and the two pre-May-2026 upload prefixes
 * (`job-<id>/`, `<wrId>/`) that older rows still carry.
 */
export const ATTACHMENT_SHAPE = uuidLeafUnder(
  "attachment",
  "(?:attachments\\/(?:jobs|workRequests)\\/\\d+|tenancy-\\d+|asset-\\d+|job-\\d+|\\d+)",
);

/** Inspection photos; a raised job's Attachments rows point at the same blob. */
export const INSPECTION_PHOTO_SHAPE = uuidLeafUnder("inspection photo", "inspections");

/** Mail-sync attachments: `email-attachments/<Graph message id>/<uuid>[.ext]` (graph.ts). */
export const EMAIL_ATTACHMENT_SHAPE = uuidLeafUnder("email attachment", "email-attachments\\/[A-Za-z0-9=_-]+");

/** Rendered purchase orders: `po/<poId>.pdf` (uploadPurchaseOrderPdf). */
export const PO_PDF_SHAPE: BlobNameShape = { label: "purchase-order PDF", pattern: /^po\/\d+\.pdf$/ };

/** Key handover photos in the `key-photos` container. */
export const KEY_PHOTO_SHAPE = uuidLeafUnder("key photo", "keys");

/** Vacancy images, vacancy slot images and building hero images in the `vacancies` container. */
export const VACANCY_SHAPE = uuidLeafUnder("vacancy image", "(?:\\d+|\\d+\\/slots|building-hero\\/-?\\d+)");

/** Everything the server mints into the `wr-attachments` container. */
export const MAJOR_EVENT_DOCUMENT_SHAPE = uuidLeafUnder("major event document", "major-events\\/[1-9][0-9]*");

export const REGISTER_DOCUMENT_SHAPE = uuidLeafUnder("register document", "documentation");

export const WR_ATTACHMENTS_SHAPES: readonly BlobNameShape[] = [
  ATTACHMENT_SHAPE,
  INSPECTION_PHOTO_SHAPE,
  EMAIL_ATTACHMENT_SHAPE,
  PO_PDF_SHAPE,
  MAJOR_EVENT_DOCUMENT_SHAPE,
  REGISTER_DOCUMENT_SHAPE,
];

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function structuralProblem(name: string): string | null {
  if (name.length === 0) return "empty";
  if (name.length > MAX_NAME_LENGTH) return "too long";
  if (CONTROL_CHARS.test(name)) return "control character";
  if (name.includes("\\")) return "backslash";
  if (name.includes("%")) return "percent sign";
  if (name.startsWith("/")) return "leading slash";
  for (const segment of name.split("/")) {
    if (segment === "") return "empty segment";
    if (segment === "." || segment === "..") return "dot segment";
  }
  return null;
}

/** Returns the name unchanged, or throws BlobNameError when it is not a minted name of one of `shapes`. */
export function assertBlobName(name: unknown, shapes: BlobNameShape | readonly BlobNameShape[]): string {
  if (typeof name !== "string") throw new BlobNameError("not a string");
  const problem = structuralProblem(name);
  if (problem) throw new BlobNameError(problem);
  const list: readonly BlobNameShape[] = "pattern" in shapes ? [shapes] : shapes;
  if (!list.some((shape) => shape.pattern.test(name))) {
    throw new BlobNameError(`not a ${list.map((shape) => shape.label).join(" or ")} name`);
  }
  return name;
}

export function isBlobName(name: unknown, shapes: BlobNameShape | readonly BlobNameShape[]): name is string {
  try {
    assertBlobName(name, shapes);
    return true;
  } catch (err) {
    if (err instanceof BlobNameError) return false;
    throw err;
  }
}
