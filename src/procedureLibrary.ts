// The procedures library's pure rules (beta sprint U4): what a block may be, who a
// procedure may be written for, and how a row becomes the shape the frontend reads.
// No database and no request here; the three handlers (getProcedures,
// saveProcedureDraft, publishProcedure) and requestProcedureApproval share it.

import { AppRole } from "./auth";

export const BLOCK_KINDS = ["heading", "image", "list", "paragraph", "table"];
export const KNOWN_AUDIENCES: string[] = ["all", ...Object.values(AppRole)];
export const REVIEW_INTERVALS = [3, 6, 12, 24];
export const MAX_BLOCKS_BYTES = 512 * 1024;

/** Rejects anything the frontend renderer would not understand. */
export function validateBlocks(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return "blocks must be an array";
  for (const block of blocks) {
    if (!block || typeof block !== "object") return "each block must be an object";
    const kind = (block as Record<string, unknown>).kind;
    if (typeof kind !== "string" || !BLOCK_KINDS.includes(kind)) {
      return `unknown block kind: ${String(kind)}`;
    }
    if (typeof (block as Record<string, unknown>).id !== "string") {
      return "each block needs a string id";
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
      from: { name: String(row.ApprovalRequestedFromName ?? ""), userId: Number(row.ApprovalRequestedFromUserId) },
    },
  };
}
