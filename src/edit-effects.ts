// Pure helpers that decide what an edit to a Quote / JobInvoice / PurchaseOrder
// implies — the human-readable diff line, whether the amount/cost changed, and
// whether the edit invalidates prior state (a previous approval or a sent /
// MYOB-created marker) that needs to be torn down.
//
// Extracted out of the handlers so the rules are testable in isolation —
// without spinning up the request/db plumbing.

function formatMoney(value: number | null): string {
  return value != null ? `$${value.toLocaleString()}` : "(no amount)";
}

function isMaterialChange(
  before: number | null,
  after: number | null | undefined,
): boolean {
  // `undefined` means "field not present in the payload" → no change.
  // `null` means "explicitly cleared" → a change if it had a value before.
  if (after === undefined) return false;
  const a = before == null ? null : Number(before);
  const b = after == null ? null : Number(after);
  return a !== b;
}

// ── Quote / Invoice share the same approval-amount shape ─────────────────────

export interface ApprovalAmountBefore {
  amount: number | null;
  contractorName: string | null;
  status: string | null;
  approvedAt: Date | null;
}

export interface ApprovalAmountChange {
  amount?: number | null;
  contractorName?: string | null;
}

export interface ApprovalAmountEffects {
  amountChanged: boolean;
  contractorChanged: boolean;
  /**
   * True when the edit invalidates a previous approval — the caller should
   * clear approval fields and revert the relevant job status.
   *
   * Fires when the amount changed AND the row was in any state past
   * "pending" (approved, awaiting director, completed, or has an ApprovedAt
   * stamp). Contractor-only edits don't invalidate approval — the approver
   * approved the amount, not the company name.
   */
  clearApproval: boolean;
  /** Human-readable diff line for the activity feed. */
  summary: string;
}

const APPROVED_STATUSES = new Set([
  "approved",
  "director_approved",
  "completed",
  "awaiting_director",
]);

export function decideApprovalAmountEdit(
  before: ApprovalAmountBefore,
  change: ApprovalAmountChange,
): ApprovalAmountEffects {
  const amountChanged = isMaterialChange(before.amount, change.amount);
  const contractorChanged =
    change.contractorName !== undefined &&
    change.contractorName !== before.contractorName;

  const wasApproved =
    (before.status != null && APPROVED_STATUSES.has(before.status)) ||
    before.approvedAt != null;

  const parts: string[] = [];
  if (amountChanged) {
    const after =
      change.amount == null ? null : Number(change.amount);
    parts.push(`amount ${formatMoney(before.amount)} → ${formatMoney(after)}`);
  }
  if (contractorChanged) {
    parts.push(
      `contractor ${before.contractorName ?? "(none)"} → ${
        change.contractorName ?? "(none)"
      }`,
    );
  }
  const summary = parts.length ? parts.join("; ") : "details updated";

  return {
    amountChanged,
    contractorChanged,
    clearApproval: amountChanged && wasApproved,
    summary,
  };
}

// ── Purchase orders: no approval status, but Sent / MYOB markers ─────────────

export interface PurchaseOrderEditBefore {
  contractorName: string | null;
  costNotToExceed: number | null;
  estimatedCost: number | null;
  sentAt: Date | null;
  myobCreatedAt: Date | null;
  completedAt: Date | null;
}

export interface PurchaseOrderEditChange {
  contractorName?: string | null;
  costNotToExceed?: number | null;
  estimatedCost?: number | null;
}

export interface PurchaseOrderEditEffects {
  estimatedCostChanged: boolean;
  costNotToExceedChanged: boolean;
  contractorChanged: boolean;
  /** True when the change should void the "sent to contractor" marker. */
  clearSentMarker: boolean;
  /** True when the change should void the "created in MYOB" marker. */
  clearMyobMarker: boolean;
  summary: string;
}

export function decidePurchaseOrderEdit(
  before: PurchaseOrderEditBefore,
  change: PurchaseOrderEditChange,
): PurchaseOrderEditEffects {
  const estimatedCostChanged = isMaterialChange(
    before.estimatedCost,
    change.estimatedCost,
  );
  const costNotToExceedChanged = isMaterialChange(
    before.costNotToExceed,
    change.costNotToExceed,
  );
  const contractorChanged =
    change.contractorName !== undefined &&
    change.contractorName !== before.contractorName;

  // Cost moves are the ones that invalidate the contractor's copy / MYOB
  // entry. Re-naming or scope tweaks don't change the dollars — leave
  // markers in place. Once the work is marked Completed, the dollars are
  // historical; we still log the edit but don't tear down markers.
  const moneyChanged = estimatedCostChanged || costNotToExceedChanged;
  const inFlight = before.completedAt == null;

  const parts: string[] = [];
  if (estimatedCostChanged) {
    const after =
      change.estimatedCost == null ? null : Number(change.estimatedCost);
    parts.push(
      `estimated cost ${formatMoney(before.estimatedCost)} → ${formatMoney(after)}`,
    );
  }
  if (costNotToExceedChanged) {
    const after =
      change.costNotToExceed == null ? null : Number(change.costNotToExceed);
    parts.push(
      `cost cap ${formatMoney(before.costNotToExceed)} → ${formatMoney(after)}`,
    );
  }
  if (contractorChanged) {
    parts.push(
      `contractor ${before.contractorName ?? "(none)"} → ${
        change.contractorName ?? "(none)"
      }`,
    );
  }
  const summary = parts.length ? parts.join("; ") : "details updated";

  return {
    contractorChanged,
    costNotToExceedChanged,
    estimatedCostChanged,
    clearSentMarker: moneyChanged && inFlight && before.sentAt != null,
    clearMyobMarker: moneyChanged && inFlight && before.myobCreatedAt != null,
    summary,
  };
}
