// The body of POST /importMyobMappings, checked before any database work.

import { isMappingKind } from "./mappingKinds";
import type { ImportInput } from "./importMappings";

export const MAX_CSV_CHARS = 1_000_000;
const MAX_NOTE = 1000;

export function parseImport(body: unknown): { ok: true; value: ImportInput } | { error: string; ok: false } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!isMappingKind(b.kind)) return { error: "kind must be suppliers, accounts or buildings", ok: false };
  if (typeof b.csv !== "string" || !b.csv.trim()) return { error: "Choose a CSV file", ok: false };
  if (b.csv.length > MAX_CSV_CHARS) return { error: "The file is larger than 1 MB; split it", ok: false };
  if (b.mode !== "preview" && b.mode !== "apply") return { error: "mode must be preview or apply", ok: false };
  const previewHash = typeof b.previewHash === "string" && /^[0-9a-f]{64}$/.test(b.previewHash) ? b.previewHash : null;
  if (b.mode === "apply" && !previewHash) return { error: "Preview the file first, then apply it", ok: false };
  if (b.note !== undefined && b.note !== null && typeof b.note !== "string") return { error: "note must be text", ok: false };
  const note = typeof b.note === "string" && b.note.trim() ? b.note.trim() : null;
  if (note && note.length > MAX_NOTE) return { error: `The note is longer than ${MAX_NOTE} characters`, ok: false };
  return { ok: true, value: { csv: b.csv, kind: b.kind, mode: b.mode, note, previewHash } };
}
