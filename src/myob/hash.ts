// The bytes a MYOB write sends, and their fingerprint. A payload is sent as
// its canonical JSON (keys sorted at every depth), so the hash shown on the
// preview and the body that leaves Floorplan are the same bytes (decision 12).

import { createHash } from "crypto";

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function payloadHash(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}
