// Request bodies for the CFO's MYOB entity endpoints, checked before any
// database work. Returns the parsed input or a plain-English reason for a 400.

import type { FileSettingsChange } from "./myob-company-files-admin";
import { isMyobFileMode } from "./myob-company-files-store";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTE = 1000;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function note(value: unknown): string | null {
  return typeof value === "string" && value.trim() && value.trim().length <= MAX_NOTE ? value.trim() : null;
}

function fileId(value: unknown): string | null {
  return typeof value === "string" && GUID.test(value.trim()) ? value.trim().toLowerCase() : null;
}

export function parseRegister(body: unknown): Parsed<{ companyFileId: string; name: string | null; note: string }> {
  const b = (body ?? {}) as Record<string, unknown>;
  const companyFileId = fileId(b.companyFileId);
  if (!companyFileId) return { error: "companyFileId must be a MYOB company file id", ok: false };
  const reason = note(b.note);
  if (!reason) return { error: "A note is required", ok: false };
  const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 200) : null;
  return { ok: true, value: { companyFileId, name, note: reason } };
}

export function parseFileSettings(body: unknown): Parsed<FileSettingsChange> {
  const b = (body ?? {}) as Record<string, unknown>;
  const companyFileId = fileId(b.companyFileId);
  if (!companyFileId) return { error: "companyFileId must be a MYOB company file id", ok: false };
  const reason = note(b.note);
  if (!reason) return { error: `A note (up to ${MAX_NOTE} characters) is required for every change`, ok: false };
  const changes: FileSettingsChange["changes"] = {};
  if (b.mode !== undefined) {
    if (!isMyobFileMode(b.mode)) return { error: "mode must be off, read or write", ok: false };
    changes.mode = b.mode;
  }
  if (b.isDemonstration !== undefined) {
    if (typeof b.isDemonstration !== "boolean") return { error: "isDemonstration must be true or false", ok: false };
    changes.isDemonstration = b.isDemonstration;
  }
  if (Object.keys(changes).length === 0) return { error: "Nothing to change", ok: false };
  const version = b.expectedRowVersion;
  if (version !== undefined && version !== null && typeof version !== "string") {
    return { error: "expectedRowVersion must be the version you loaded", ok: false };
  }
  return { ok: true, value: { changes, companyFileId, expectedRowVersion: (version as string | null | undefined) || null, note: reason } };
}
