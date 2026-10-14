// Request bodies for the CFO's MYOB control endpoints, checked before any
// database work. Returns the parsed input or a plain-English reason for a 400.

import type { ControlChangeInput, ControlChanges } from "./myob-controls-admin";
import { isControlOperation } from "./myob-controls-store";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTE = 1000;
const MAX_DAILY_CAP = 10_000;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function note(value: unknown): string | null {
  return typeof value === "string" && value.trim() && value.trim().length <= MAX_NOTE ? value.trim() : null;
}

export function parseControlChange(body: unknown): Parsed<ControlChangeInput> {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.companyFileId !== "string" || !GUID.test(b.companyFileId)) return { error: "companyFileId must be a MYOB company file id", ok: false };
  if (!isControlOperation(b.operation)) return { error: "operation is not a MYOB control", ok: false };
  const reason = note(b.note);
  if (!reason) return { error: `A note (up to ${MAX_NOTE} characters) is required for every change`, ok: false };

  const changes: ControlChanges = {};
  for (const key of ["enabled", "dryRun", "requireReview"] as const) {
    if (b[key] === undefined) continue;
    if (typeof b[key] !== "boolean") return { error: `${key} must be true or false`, ok: false };
    changes[key] = b[key] as boolean;
  }
  if (b.dailyCap !== undefined) {
    if (typeof b.dailyCap !== "number" || !Number.isInteger(b.dailyCap) || b.dailyCap < 0 || b.dailyCap > MAX_DAILY_CAP) {
      return { error: `dailyCap must be a whole number from 0 to ${MAX_DAILY_CAP}`, ok: false };
    }
    changes.dailyCap = b.dailyCap;
  }
  if (Object.keys(changes).length === 0) return { error: "Nothing to change", ok: false };
  if (b.expectedRowVersion !== undefined && b.expectedRowVersion !== null && typeof b.expectedRowVersion !== "string") {
    return { error: "expectedRowVersion must be the version you loaded", ok: false };
  }
  return {
    ok: true,
    value: {
      changes,
      companyFileId: b.companyFileId.toLowerCase(),
      expectedRowVersion: (b.expectedRowVersion as string | null | undefined) || null,
      note: reason,
      operation: b.operation,
    },
  };
}

export function parsePause(body: unknown): Parsed<{ companyFileId: string | null; note: string; paused: boolean }> {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.paused !== "boolean") return { error: "paused must be true or false", ok: false };
  const file = b.companyFileId ?? null;
  if (file !== null && (typeof file !== "string" || !GUID.test(file))) return { error: "companyFileId must be a MYOB company file id", ok: false };
  const reason = note(b.note);
  if (!reason) return { error: "A note is required", ok: false };
  return { ok: true, value: { companyFileId: file ? file.toLowerCase() : null, note: reason, paused: b.paused } };
}
