// Unit tests for the Jobs upsert Kind-column guards (m079 / WP9).
//
// The Kind validation + the "emit a kind_change event?" decision are mirrored
// here as pure functions matching the inline logic in src/functions/jobs.ts,
// so they stay testable without spinning up a real DB connection — the same
// pattern as purchaseOrders.test.ts.

import assert from "node:assert";

// ── Mirrors of production logic ──────────────────────────────────────────────

const ALLOWED_KINDS = ["facilities", "maintenance"] as const;

/** Returns an error string if the Kind value should be rejected, null if it
 *  passes. Mirrors the Kind branch of validateUpsertBody. An omitted Kind
 *  (undefined) is "no change", never an error. */
function validateKind(kind: unknown): string | null {
  if (
    kind !== undefined &&
    kind !== null &&
    !ALLOWED_KINDS.includes(kind as (typeof ALLOWED_KINDS)[number])
  ) {
    return "Invalid Kind";
  }
  return null;
}

/** Whether the UPDATE transaction should write a kind_change JobEvent.
 *  Mirrors `newKind !== undefined && newKind !== previous.Kind`. */
function shouldEmitKindChange(
  previousKind: string | null,
  newKind: string | null | undefined,
): boolean {
  return newKind !== undefined && newKind !== previousKind;
}

// ── validateKind ─────────────────────────────────────────────────────────────

test("validateKind accepts facilities", () => {
  assert.strictEqual(validateKind("facilities"), null);
});

test("validateKind accepts maintenance", () => {
  assert.strictEqual(validateKind("maintenance"), null);
});

test("validateKind passes when Kind is omitted (undefined)", () => {
  assert.strictEqual(validateKind(undefined), null);
});

test("validateKind passes when Kind is null", () => {
  assert.strictEqual(validateKind(null), null);
});

test("validateKind rejects an unknown kind", () => {
  assert.strictEqual(validateKind("plumbing"), "Invalid Kind");
});

test("validateKind rejects a wrong-case value (stored token is lowercase)", () => {
  assert.strictEqual(validateKind("Maintenance"), "Invalid Kind");
});

// ── shouldEmitKindChange ───────────────────────────────────────────────────────

test("emits kind_change when kind actually changes", () => {
  assert.strictEqual(shouldEmitKindChange("facilities", "maintenance"), true);
});

test("does not emit when the new kind equals the previous", () => {
  assert.strictEqual(shouldEmitKindChange("maintenance", "maintenance"), false);
});

test("does not emit when Kind is absent from the payload (no change)", () => {
  assert.strictEqual(shouldEmitKindChange("facilities", undefined), false);
});

test("emits when flipping maintenance back to facilities", () => {
  assert.strictEqual(shouldEmitKindChange("maintenance", "facilities"), true);
});
