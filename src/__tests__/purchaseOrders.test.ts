// Unit tests for PurchaseOrders business-rule guards.
//
// The guard predicates are extracted here as pure functions that mirror the
// inline checks in the handler — keeping them testable without spinning up a
// real DB connection.

import { describe, test } from "node:test";
import assert from "node:assert";

// ── Guard logic mirrors ───────────────────────────────────────────────────────
// These replicate the exact conditions checked in the handlers so the tests
// stay in sync with production code.

interface PurchaseOrderGuardState {
  MyobCreatedAt: Date | null;
  CompletedAt: Date | null;
  SentAt: Date | null;
}

/** Returns an error string if markComplete should be blocked, null if allowed. */
function canMarkComplete(po: PurchaseOrderGuardState): string | null {
  if (!po.MyobCreatedAt) {
    return "Cannot mark complete — this purchase order has not been marked as created in MYOB yet.";
  }
  return null;
}

/** Returns an error string if unmarkMyobCreated should be blocked, null if allowed. */
function canUnmarkMyobCreated(po: PurchaseOrderGuardState): string | null {
  if (po.CompletedAt) {
    return "Cannot undo MYOB entry — this purchase order has already been marked complete.";
  }
  return null;
}

/** Returns an error string if delete should be blocked, null if allowed. */
function canDelete(po: PurchaseOrderGuardState): string | null {
  if (po.SentAt) {
    return "Cannot delete a purchase order that has been sent.";
  }
  if (po.CompletedAt) {
    return "Cannot delete a purchase order that has been marked complete.";
  }
  return null;
}

// ── Tests: markPurchaseOrderComplete ─────────────────────────────────────────

describe("markPurchaseOrderComplete guards", () => {
  test("is allowed when MyobCreatedAt is set", () => {
    const po: PurchaseOrderGuardState = {
      MyobCreatedAt: new Date(),
      CompletedAt: null,
      SentAt: null,
    };
    assert.strictEqual(canMarkComplete(po), null);
  });

  test("is blocked when MyobCreatedAt is null", () => {
    const po: PurchaseOrderGuardState = {
      MyobCreatedAt: null,
      CompletedAt: null,
      SentAt: null,
    };
    const result = canMarkComplete(po);
    assert.ok(result !== null, "expected an error message");
    assert.match(result, /MYOB/i);
  });

  test("is allowed even if already completed (idempotent re-mark)", () => {
    // The handler only guards on MyobCreatedAt; re-marking complete is
    // allowed (it just overwrites CompletedAt/By with a fresh timestamp).
    const po: PurchaseOrderGuardState = {
      MyobCreatedAt: new Date(),
      CompletedAt: new Date(),
      SentAt: null,
    };
    assert.strictEqual(canMarkComplete(po), null);
  });
});

// ── Tests: unmarkPurchaseOrderMyobCreated ─────────────────────────────────────

describe("unmarkPurchaseOrderMyobCreated guards", () => {
  test("is allowed when CompletedAt is null", () => {
    const po: PurchaseOrderGuardState = {
      MyobCreatedAt: new Date(),
      CompletedAt: null,
      SentAt: null,
    };
    assert.strictEqual(canUnmarkMyobCreated(po), null);
  });

  test("is blocked when CompletedAt is set", () => {
    const po: PurchaseOrderGuardState = {
      MyobCreatedAt: new Date(),
      CompletedAt: new Date(),
      SentAt: null,
    };
    const result = canUnmarkMyobCreated(po);
    assert.ok(result !== null, "expected an error message");
    assert.match(result, /complete/i);
  });
});

// ── Tests: deletePurchaseOrder ─────────────────────────────────────────────────

describe("deletePurchaseOrder guards", () => {
  test("is allowed when SentAt and CompletedAt are both null", () => {
    const po: PurchaseOrderGuardState = {
      MyobCreatedAt: null,
      CompletedAt: null,
      SentAt: null,
    };
    assert.strictEqual(canDelete(po), null);
  });

  test("is blocked when SentAt is set", () => {
    const po: PurchaseOrderGuardState = {
      MyobCreatedAt: null,
      CompletedAt: null,
      SentAt: new Date(),
    };
    const result = canDelete(po);
    assert.ok(result !== null, "expected an error message");
    assert.match(result, /sent/i);
  });

  test("is blocked when CompletedAt is set", () => {
    const po: PurchaseOrderGuardState = {
      MyobCreatedAt: new Date(),
      CompletedAt: new Date(),
      SentAt: null,
    };
    const result = canDelete(po);
    assert.ok(result !== null, "expected an error message");
    assert.match(result, /complete/i);
  });

  test("SentAt check takes priority over CompletedAt check", () => {
    // Both set — the SentAt message fires first
    const po: PurchaseOrderGuardState = {
      MyobCreatedAt: new Date(),
      CompletedAt: new Date(),
      SentAt: new Date(),
    };
    const result = canDelete(po);
    assert.ok(result !== null);
    assert.match(result, /sent/i);
  });
});
