// The procedures library's pure rules (beta sprint U4): what a block may be, who a
// procedure may be written for, and how a row becomes the shape the frontend reads.
// No database and no request here; the three handlers (getProcedures,
// saveProcedureDraft, publishProcedure) and requestProcedureApproval share it.

import { AppRole } from "./auth";

export const BLOCK_KINDS = [
  "heading",
  "image",
  "list",
  "paragraph",
  "table",
  "checklist",
  "steps",
  "decision",
  "diagram",
];
export const KNOWN_AUDIENCES: string[] = ["all", ...Object.values(AppRole)];
export const REVIEW_INTERVALS = [0, 3, 6, 12, 24];
export const MAX_BLOCKS_BYTES = 512 * 1024;

/** Rejects anything the frontend renderer would not understand. */
export function validateBlocks(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return "blocks must be an array";
  if (blocks.length > 500) return "Use at most 500 modules";
  const ids = new Set<string>();
  const text = (value: unknown) => typeof value === "string" && value.length <= 50000;
  const list = (value: unknown) => Array.isArray(value) && value.length <= 500 && value.every(text);
  for (const block of blocks) {
    if (!block || typeof block !== "object") return "each block must be an object";
    const b = block as Record<string, unknown>;
    const kind = b.kind;
    if (typeof kind !== "string" || !BLOCK_KINDS.includes(kind)) return `unknown block kind: ${String(kind)}`;
    if (typeof b.id !== "string" || !b.id || b.id.length > 200 || ids.has(b.id))
      return "each block needs a unique string id";
    ids.add(b.id);
    if ((kind === "heading" || kind === "paragraph") && !text(b.text)) return "Text must be a string";
    if (kind === "heading" && b.level !== 2 && b.level !== 3) return "Heading level must be 2 or 3";
    if (["list", "checklist", "steps", "diagram"].includes(kind) && !list(b.items))
      return "Items must be a list of text";
    if (kind === "list" && typeof b.ordered !== "boolean") return "List style is required";
    if (kind === "decision" && ![b.question, b.yes, b.no].every(text))
      return "Response guide needs a question and yes/no instructions";
    if (
      kind === "table" &&
      (!list(b.header) ||
        !Array.isArray(b.rows) ||
        b.rows.length > 500 ||
        !b.rows.every((row) => list(row) && row.length === (b.header as string[]).length))
    )
      return "Table rows must match its header";
    if (kind === "image") {
      if (!text(b.url) || !text(b.alt) || (b.caption !== undefined && !text(b.caption)))
        return "Image needs a URL and description";
      if (b.url) {
        try {
          if (!["https:", "http:"].includes(new URL(b.url as string).protocol))
            return "Use an HTTP(S) image URL";
        } catch {
          return "Use a valid image URL";
        }
      }
    }
  }
  return null;
}

/** A corrupt document renders empty rather than taking the library down. */
export function parseBlocks(json: unknown, slug: string, warn: (message: string) => void): unknown[] {
  try {
    const parsed: unknown = JSON.parse(String(json));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    warn(`procedures: unparseable BlocksJson for ${slug}`);
    return [];
  }
}

/** "facilities, accounts" as stored → ["facilities", "accounts"]. */
export function splitAudience(stored: unknown): string[] {
  return String(stored ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export const toIsoDateTime = (value: unknown): string | undefined =>
  value ? new Date(value as Date).toISOString() : undefined;

export const toIsoDate = (value: unknown): string | undefined =>
  value ? new Date(value as Date).toISOString().slice(0, 10) : undefined;

/** The request for approval on a draft, when there is one. Only a draft carries a live request. */
export function approvalRequestOf(row: Record<string, unknown>): { approvalRequest?: unknown } {
  if (String(row.Status) !== "draft" || !row.ApprovalRequestedAt) return {};
  return {
    approvalRequest: {
      at: toIsoDateTime(row.ApprovalRequestedAt),
      by: String(row.ApprovalRequestedBy ?? ""),
      from: {
        name: String(row.ApprovalRequestedFromName ?? ""),
        userId: Number(row.ApprovalRequestedFromUserId),
      },
    },
  };
}
