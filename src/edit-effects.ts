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
  /** Quotes carry the contractor's id as well as its name. */
  contractorId?: number | null;
  contractorName: string | null;
  status: string | null;
  approvedAt: Date | null;
}

export interface ApprovalAmountChange {
  amount?: number | null;
  contractorId?: number | null;
  contractorName?: string | null;
}

/** The payee changed: a different contractor id, or a different name. Undefined fields are no change. */
function payeeChanged(
  before: { contractorId?: number | null; contractorName: string | null },
  change: { contractorId?: number | null; contractorName?: string | null },
): boolean {
  const idChanged = change.contractorId !== undefined && (change.contractorId ?? null) !== (before.contractorId ?? null);
  const nameChanged = change.contractorName !== undefined && change.contractorName !== before.contractorName;
  return idChanged || nameChanged;
}

export interface ApprovalAmountEffects {
  amountChanged: boolean;
  contractorChanged: boolean;
  /**
   * True when the edit invalidates a previous approval — the caller clears the
   * approval fields (and, for an invoice, any MYOB mark). It never moves the
   * job (J2).
   *
   * Fires when the amount or the payee changed AND the row was in any state
   * past "pending" (approved, awaiting director, completed, or has an
   * ApprovedAt stamp). The approver approved paying this amount to this
   * contractor; a different payee is a different decision (J3).
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
  const contractorChanged = payeeChanged(before, change);

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
    clearApproval: (amountChanged || contractorChanged) && wasApproved,
    summary,
  };
}

// ── Purchase orders: no approval status, but Sent / MYOB markers ─────────────

export interface PurchaseOrderEditBefore {
  contractorId?: number | null;
  contractorName: string | null;
  costNotToExceed: number | null;
  estimatedCost: number | null;
  sentAt: Date | null;
  myobCreatedAt: Date | null;
  completedAt: Date | null;
}

export interface PurchaseOrderEditChange {
  contractorId?: number | null;
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
  const contractorChanged = payeeChanged(before, change);

  // Cost and payee moves invalidate the contractor's copy and the MYOB entry
  // (a PO to a different contractor is a different PO, J3). Scope tweaks
  // leave markers in place. Once the work is marked Completed, the record is
  // historical; we still log the edit but don't tear down markers.
  const moneyChanged = estimatedCostChanged || costNotToExceedChanged || contractorChanged;
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
