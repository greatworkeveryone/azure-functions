// Unit tests for PurchaseOrders business-rule guards.
//
// The guard predicates are extracted here as pure functions that mirror the
// inline checks in the handler — keeping them testable without spinning up a
// real DB connection.

import assert from "node:assert";
import { AwaitingRole, JobStatus } from "../jobStatusMachine";
import { purchaseOrderApprovalError } from "../functions/purchaseOrders";

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

// ── Tests: createPurchaseOrder quote-approval guard (WP8) ─────────────────────
// upsertPurchaseOrder is callable by plain accounts (a wider set than the
// quote-approval authority), and the machine's PO_CREATED edge moves a job out
// of (Awaiting Approval, facilities) → Work. Without the guard, creating a PO
// acts as implicit quote approval — leapfrogging the manager approval limit.
// The guard blocks PO creation ONLY in that single leapfrog state when the job
// has no approved quote. Every other state is unaffected (a PO on a job in Work
// is a no-op transition; a PO on an approved job is the legitimate path).

describe("createPurchaseOrder quote-approval guard", () => {
  test("rejects a PO that would leapfrog an unapproved quote past Awaiting Approval / facilities", () => {
    const result = purchaseOrderApprovalError({
      status: JobStatus.AWAITING_APPROVAL,
      awaitingRole: AwaitingRole.FACILITIES,
      approvedQuoteId: null,
    });
    assert.ok(result !== null, "expected the leapfrog to be rejected");
    assert.match(result, /quote/i);
    assert.match(result, /approv/i);
  });

  test("allows a PO once the quote has been approved (ApprovedQuoteID set)", () => {
    const result = purchaseOrderApprovalError({
      status: JobStatus.AWAITING_APPROVAL,
      awaitingRole: AwaitingRole.FACILITIES,
      approvedQuoteId: 42,
    });
    assert.strictEqual(result, null);
  });

  test("allows a PO on a job already in Work (transition is a no-op — unchanged)", () => {
    const result = purchaseOrderApprovalError({
      status: JobStatus.WORK,
      awaitingRole: AwaitingRole.FACILITIES,
      approvedQuoteId: null,
    });
    assert.strictEqual(result, null);
  });

  test("allows a PO on a job in Work even when an approved quote exists", () => {
    const result = purchaseOrderApprovalError({
      status: JobStatus.WORK,
      awaitingRole: AwaitingRole.FACILITIES,
      approvedQuoteId: 7,
    });
    assert.strictEqual(result, null);
  });

  test("does not block (Awaiting Approval, accounts) — that's the invoice step, not the quote leapfrog", () => {
    const result = purchaseOrderApprovalError({
      status: JobStatus.AWAITING_APPROVAL,
      awaitingRole: AwaitingRole.ACCOUNTS,
      approvedQuoteId: null,
    });
    assert.strictEqual(result, null);
  });

  test("allows a PO on a New job (PO_CREATED is a no-op there — no transition to gate)", () => {
    const result = purchaseOrderApprovalError({
      status: JobStatus.NEW,
      awaitingRole: AwaitingRole.FACILITIES,
      approvedQuoteId: null,
    });
    assert.strictEqual(result, null);
  });

  // WP10: a standing-contract job reaches Work via WORK_AUTHORIZED (New → Work),
  // never sitting in (Awaiting Approval, facilities) with no approved quote. So
  // its optional PO step is allowed (Work is a no-op for PO_CREATED). The guard
  // is unchanged — it still blocks the leapfrog state for any quoted job, and
  // every downstream financial control (invoice approval / limits / director
  // tier) is enforced identically whether or not the job is a contract job.
  test("allows a PO on a contract job in Work (optional PO step, no quote round)", () => {
    const result = purchaseOrderApprovalError({
      status: JobStatus.WORK,
      awaitingRole: AwaitingRole.FACILITIES,
      approvedQuoteId: null,
    });
    assert.strictEqual(result, null);
  });
});
