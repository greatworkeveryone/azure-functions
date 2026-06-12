// Unit tests for the pure edit-effect helpers that drive what happens when
// a Quote / JobInvoice / PurchaseOrder is edited via the upsert endpoints.
// These pin the rules down without mocking the handler / db plumbing.

import assert from "node:assert";
import {
  decideApprovalAmountEdit,
  decidePurchaseOrderEdit,
} from "../edit-effects";

// ─────────────────────────────────────────────────────────────────────────────
// decideApprovalAmountEdit — shared by Quote + JobInvoice
// ─────────────────────────────────────────────────────────────────────────────

const PENDING_QUOTE = {
  amount: 150,
  approvedAt: null,
  contractorName: "A&D Plumbing",
  status: "pending",
};

const APPROVED_QUOTE = {
  amount: 150,
  approvedAt: new Date("2026-05-31T10:00:00Z"),
  contractorName: "A&D Plumbing",
  status: "approved",
};

const COMPLETED_QUOTE = { ...APPROVED_QUOTE, status: "completed" };
const DIRECTOR_APPROVED_QUOTE = { ...APPROVED_QUOTE, status: "director_approved" };
const AWAITING_DIRECTOR_QUOTE = {
  ...PENDING_QUOTE,
  status: "awaiting_director",
};

describe("decideApprovalAmountEdit", () => {
  describe("no-op edits", () => {
    test("empty change object returns no diff and no revert", () => {
      const effects = decideApprovalAmountEdit(APPROVED_QUOTE, {});
      assert.strictEqual(effects.amountChanged, false);
      assert.strictEqual(effects.contractorChanged, false);
      assert.strictEqual(effects.clearApproval, false);
      assert.strictEqual(effects.summary, "details updated");
    });

    test("amount sent identical to current is not a change", () => {
      const effects = decideApprovalAmountEdit(APPROVED_QUOTE, {
        amount: 150,
      });
      assert.strictEqual(effects.amountChanged, false);
      assert.strictEqual(effects.clearApproval, false);
    });

    test("contractor sent identical is not a change", () => {
      const effects = decideApprovalAmountEdit(APPROVED_QUOTE, {
        contractorName: "A&D Plumbing",
      });
      assert.strictEqual(effects.contractorChanged, false);
    });
  });

  describe("amount change on a pending quote", () => {
    test("logs a diff line but does NOT clear approval", () => {
      const effects = decideApprovalAmountEdit(PENDING_QUOTE, {
        amount: 25000,
      });
      assert.strictEqual(effects.amountChanged, true);
      assert.strictEqual(effects.clearApproval, false);
      assert.match(effects.summary, /\$150.+\$25,000/);
    });
  });

  describe("amount change on an approved quote", () => {
    test("triggers approval clear", () => {
      const effects = decideApprovalAmountEdit(APPROVED_QUOTE, {
        amount: 25000,
      });
      assert.strictEqual(effects.amountChanged, true);
      assert.strictEqual(effects.clearApproval, true);
      assert.match(effects.summary, /amount \$150.+\$25,000/);
    });

    test("director-approved row also clears on amount change", () => {
      const effects = decideApprovalAmountEdit(DIRECTOR_APPROVED_QUOTE, {
        amount: 25000,
      });
      assert.strictEqual(effects.clearApproval, true);
    });

    test("completed row also clears on amount change", () => {
      const effects = decideApprovalAmountEdit(COMPLETED_QUOTE, {
        amount: 25000,
      });
      assert.strictEqual(effects.clearApproval, true);
    });

    test("awaiting_director row also clears on amount change", () => {
      const effects = decideApprovalAmountEdit(AWAITING_DIRECTOR_QUOTE, {
        amount: 25000,
      });
      assert.strictEqual(effects.clearApproval, true);
    });

    test("pending row with a stamped ApprovedAt is treated as approved", () => {
      // Defensive: status was demoted but the approval audit fields were left
      // behind. We still treat this as "had been approved" → tear it down.
      const odd = {
        ...PENDING_QUOTE,
        approvedAt: new Date(),
      };
      const effects = decideApprovalAmountEdit(odd, { amount: 25000 });
      assert.strictEqual(effects.clearApproval, true);
    });
  });

  describe("contractor change", () => {
    test("on its own does NOT clear approval — approval is on the amount", () => {
      const effects = decideApprovalAmountEdit(APPROVED_QUOTE, {
        contractorName: "New Plumbing Co",
      });
      assert.strictEqual(effects.contractorChanged, true);
      assert.strictEqual(effects.amountChanged, false);
      assert.strictEqual(effects.clearApproval, false);
      assert.match(effects.summary, /contractor A&D Plumbing → New Plumbing Co/);
    });

    test("paired with an amount change keeps the clear", () => {
      const effects = decideApprovalAmountEdit(APPROVED_QUOTE, {
        amount: 200,
        contractorName: "New Plumbing Co",
      });
      assert.strictEqual(effects.clearApproval, true);
      assert.match(effects.summary, /amount.+contractor/);
    });
  });

  describe("null handling", () => {
    test("clearing amount on an approved row is treated as a change → clear", () => {
      const effects = decideApprovalAmountEdit(APPROVED_QUOTE, {
        amount: null,
      });
      assert.strictEqual(effects.amountChanged, true);
      assert.strictEqual(effects.clearApproval, true);
      assert.match(effects.summary, /\$150.+\(no amount\)/);
    });

    test("setting amount on a row that had no amount is a change", () => {
      const before = { ...PENDING_QUOTE, amount: null };
      const effects = decideApprovalAmountEdit(before, { amount: 500 });
      assert.strictEqual(effects.amountChanged, true);
      assert.match(effects.summary, /\(no amount\).+\$500/);
    });

    test("missing field (undefined) is not a change", () => {
      const effects = decideApprovalAmountEdit(APPROVED_QUOTE, {
        contractorName: "Other",
      });
      assert.strictEqual(effects.amountChanged, false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// decidePurchaseOrderEdit — different lifecycle (sent / MYOB / completed)
// ─────────────────────────────────────────────────────────────────────────────

const DRAFT_PO = {
  completedAt: null,
  contractorName: "A&D Plumbing",
  costNotToExceed: null,
  estimatedCost: 150,
  myobCreatedAt: null,
  sentAt: null,
};

const SENT_PO = { ...DRAFT_PO, sentAt: new Date("2026-05-31T10:00:00Z") };
const MYOB_PO = {
  ...SENT_PO,
  myobCreatedAt: new Date("2026-05-31T11:00:00Z"),
};
const COMPLETED_PO = {
  ...MYOB_PO,
  completedAt: new Date("2026-05-31T12:00:00Z"),
};

describe("decidePurchaseOrderEdit", () => {
  describe("no-op edits", () => {
    test("empty change → no events, no clears", () => {
      const effects = decidePurchaseOrderEdit(MYOB_PO, {});
      assert.strictEqual(effects.estimatedCostChanged, false);
      assert.strictEqual(effects.clearSentMarker, false);
      assert.strictEqual(effects.clearMyobMarker, false);
      assert.strictEqual(effects.summary, "details updated");
    });

    test("identical cost is not a change", () => {
      const effects = decidePurchaseOrderEdit(MYOB_PO, {
        estimatedCost: 150,
      });
      assert.strictEqual(effects.estimatedCostChanged, false);
      assert.strictEqual(effects.clearMyobMarker, false);
    });
  });

  describe("cost change on a draft (not yet sent / MYOB'd)", () => {
    test("logs the diff but clears nothing — nothing downstream to invalidate", () => {
      const effects = decidePurchaseOrderEdit(DRAFT_PO, {
        estimatedCost: 25000,
      });
      assert.strictEqual(effects.estimatedCostChanged, true);
      assert.strictEqual(effects.clearSentMarker, false);
      assert.strictEqual(effects.clearMyobMarker, false);
      assert.match(effects.summary, /estimated cost \$150 → \$25,000/);
    });
  });

  describe("cost change after the PO was sent", () => {
    test("clears the sent marker so the user re-sends", () => {
      const effects = decidePurchaseOrderEdit(SENT_PO, {
        estimatedCost: 25000,
      });
      assert.strictEqual(effects.clearSentMarker, true);
      assert.strictEqual(effects.clearMyobMarker, false);
    });
  });

  describe("cost change after MYOB", () => {
    test("clears both the sent AND MYOB markers", () => {
      const effects = decidePurchaseOrderEdit(MYOB_PO, {
        estimatedCost: 25000,
      });
      assert.strictEqual(effects.clearSentMarker, true);
      assert.strictEqual(effects.clearMyobMarker, true);
    });

    test("cap (not-to-exceed) change also clears markers", () => {
      const effects = decidePurchaseOrderEdit(MYOB_PO, {
        costNotToExceed: 30000,
      });
      assert.strictEqual(effects.costNotToExceedChanged, true);
      assert.strictEqual(effects.clearSentMarker, true);
      assert.strictEqual(effects.clearMyobMarker, true);
    });
  });

  describe("cost change after work was marked complete", () => {
    test("logs the diff but leaves markers alone — dollars are historical", () => {
      const effects = decidePurchaseOrderEdit(COMPLETED_PO, {
        estimatedCost: 25000,
      });
      assert.strictEqual(effects.estimatedCostChanged, true);
      assert.strictEqual(effects.clearSentMarker, false);
      assert.strictEqual(effects.clearMyobMarker, false);
    });
  });

  describe("non-cost edits", () => {
    test("contractor rename on a MYOB'd PO does NOT clear markers", () => {
      // Renaming the recipient row isn't the same as the contractor's PO
      // copy being wrong — leave the markers, just log the rename.
      const effects = decidePurchaseOrderEdit(MYOB_PO, {
        contractorName: "Other Plumbing",
      });
      assert.strictEqual(effects.contractorChanged, true);
      assert.strictEqual(effects.clearSentMarker, false);
      assert.strictEqual(effects.clearMyobMarker, false);
      assert.match(effects.summary, /contractor A&D Plumbing → Other Plumbing/);
    });
  });

  describe("paired changes", () => {
    test("contractor + cost on a sent PO clears the sent marker (cost is the trigger)", () => {
      const effects = decidePurchaseOrderEdit(SENT_PO, {
        contractorName: "Other Plumbing",
        estimatedCost: 200,
      });
      assert.strictEqual(effects.clearSentMarker, true);
      assert.match(effects.summary, /estimated cost.+contractor/);
    });
  });
});
