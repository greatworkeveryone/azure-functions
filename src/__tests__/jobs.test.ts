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

// ── WP10: standing-contract flip guard + audit event ─────────────────────────
// Mirrors of the inline upsertJob logic: isContract may only flip while the job
// is still New; a real flip emits a contract_change event. Same mirror-the-guard
// pattern as above (the handler registers app.http at module scope).

/** Returns an error string if the contract flip should be rejected, else null.
 *  Mirrors the IsContract guard in upsertJob's UPDATE branch. */
function contractFlipError(
  previousStatus: string,
  previousIsContract: boolean,
  newIsContract: boolean | undefined,
): string | null {
  if (newIsContract === undefined) return null; // not in payload — no change
  if (Boolean(newIsContract) === previousIsContract) return null; // no-op
  if (previousStatus !== "New") {
    return "Contract status can only be changed while the job is New.";
  }
  return null;
}

/** Whether the UPDATE transaction should write a contract_change JobEvent.
 *  Mirrors `newIsContract !== undefined && Boolean(newIsContract) !== Boolean(previous.IsContract)`. */
function shouldEmitContractChange(
  previousIsContract: boolean,
  newIsContract: boolean | undefined,
): boolean {
  return newIsContract !== undefined && Boolean(newIsContract) !== previousIsContract;
}

test("contractFlipError allows turning on the flag while New", () => {
  assert.strictEqual(contractFlipError("New", false, true), null);
});

test("contractFlipError allows turning off the flag while New", () => {
  assert.strictEqual(contractFlipError("New", true, false), null);
});

test("contractFlipError rejects flipping the flag once past New", () => {
  assert.strictEqual(
    contractFlipError("Work", false, true),
    "Contract status can only be changed while the job is New.",
  );
  assert.strictEqual(
    contractFlipError("Awaiting Approval", true, false),
    "Contract status can only be changed while the job is New.",
  );
});

test("contractFlipError is a no-op when the flag is absent or unchanged", () => {
  assert.strictEqual(contractFlipError("Work", true, undefined), null);
  assert.strictEqual(contractFlipError("Work", true, true), null);
  assert.strictEqual(contractFlipError("Done", false, false), null);
});

test("shouldEmitContractChange emits only on a real flip", () => {
  assert.strictEqual(shouldEmitContractChange(false, true), true);
  assert.strictEqual(shouldEmitContractChange(true, false), true);
  assert.strictEqual(shouldEmitContractChange(false, false), false);
  assert.strictEqual(shouldEmitContractChange(true, undefined), false);
});

// ── WP18a: D4 upsert machine guard (status/awaiting-role ownership) ──────────
// Mirrors the inline branches in upsertJob: a job is born 'New' with a default
// AwaitingRole='facilities'; once it exists, neither Status nor AwaitingRole may
// be written through upsertJob — those transitions go through addJobEvent.

interface UpsertGuardResult {
  status: number;
  error?: string;
  /** The AwaitingRole the create path would persist (after defaulting). */
  awaitingRole?: string;
}

/** Mirror of upsertJob's create-path Status/AwaitingRole guard. */
function upsertCreateGuard(fields: {
  Status?: string;
  AwaitingRole?: string | null;
}): UpsertGuardResult {
  if (fields.Status !== "New") {
    return { status: 400, error: "Status must be 'New' when creating a job" };
  }
  const awaitingRole =
    fields.AwaitingRole === undefined || fields.AwaitingRole === null
      ? "facilities"
      : fields.AwaitingRole;
  return { status: 200, awaitingRole };
}

/** Mirror of upsertJob's update-path Status/AwaitingRole rejection. */
function upsertUpdateGuard(fields: {
  Status?: string;
  AwaitingRole?: string;
}): UpsertGuardResult {
  if (fields.Status !== undefined) {
    return {
      status: 422,
      error: "Status changes must use the addJobEvent endpoint, not upsertJob.",
    };
  }
  if (fields.AwaitingRole !== undefined) {
    return {
      status: 422,
      error:
        "AwaitingRole changes must use the addJobEvent endpoint, not upsertJob.",
    };
  }
  return { status: 200 };
}

test("create rejects a non-New status with 400", () => {
  assert.deepStrictEqual(upsertCreateGuard({ Status: "Work" }), {
    status: 400,
    error: "Status must be 'New' when creating a job",
  });
});

test("create accepts New and defaults AwaitingRole to facilities", () => {
  assert.deepStrictEqual(upsertCreateGuard({ Status: "New" }), {
    status: 200,
    awaitingRole: "facilities",
  });
});

test("create defaults AwaitingRole when explicitly null", () => {
  assert.deepStrictEqual(upsertCreateGuard({ Status: "New", AwaitingRole: null }), {
    status: 200,
    awaitingRole: "facilities",
  });
});

test("create preserves a provided AwaitingRole on a New job", () => {
  assert.deepStrictEqual(
    upsertCreateGuard({ Status: "New", AwaitingRole: "accounts" }),
    { status: 200, awaitingRole: "accounts" },
  );
});

test("update rejects any Status write with 422", () => {
  assert.deepStrictEqual(upsertUpdateGuard({ Status: "Work" }), {
    status: 422,
    error: "Status changes must use the addJobEvent endpoint, not upsertJob.",
  });
});

test("update rejects any AwaitingRole write with 422", () => {
  assert.deepStrictEqual(upsertUpdateGuard({ AwaitingRole: "accounts" }), {
    status: 422,
    error:
      "AwaitingRole changes must use the addJobEvent endpoint, not upsertJob.",
  });
});

test("update with no lifecycle fields passes the guard", () => {
  assert.deepStrictEqual(upsertUpdateGuard({}), { status: 200 });
});

// ── WP18a: acknowledge mirror + clear-on-transition ──────────────────────────
// Mirrors the addJobEvent mirror-UPDATE accountability clauses. The acknowledge
// event stamps AcknowledgedAt/By; a real status transition resets the whole
// clock (StatusSince=now, ack + escalation cleared); a self-transition no-op
// leaves it untouched. The two paths never both write AcknowledgedAt.

/** Returns the set of Jobs columns the mirror UPDATE would touch (and their
 *  symbolic values) given the event type and whether the status really moved.
 *  Mirrors the `if (EventType === "acknowledged" && !isRealTransition)` and
 *  `if (isRealTransition)` blocks. */
function accountabilityMirror(
  eventType: string | undefined,
  isRealTransition: boolean,
  acknowledgedBy: string,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if (eventType === "acknowledged" && !isRealTransition) {
    out.AcknowledgedAt = "now";
    out.AcknowledgedBy = acknowledgedBy;
  }
  if (isRealTransition) {
    out.StatusSince = "now";
    out.AcknowledgedAt = null;
    out.AcknowledgedBy = null;
    out.EscalatedAt = null;
  }
  return out;
}

/** Mirror of the isRealTransition computation in addJobEvent: a composite move
 *  (status OR awaitingRole changed), never a self-transition. */
function computeIsRealTransition(
  from: { status: string; awaitingRole: string },
  to: { status: string; awaitingRole: string },
): boolean {
  return from.status !== to.status || from.awaitingRole !== to.awaitingRole;
}

test("acknowledge event stamps AcknowledgedAt/By and nothing else", () => {
  assert.deepStrictEqual(accountabilityMirror("acknowledged", false, "Alice"), {
    AcknowledgedAt: "now",
    AcknowledgedBy: "Alice",
  });
});

test("a real transition resets the clock and clears ack + escalation", () => {
  assert.deepStrictEqual(accountabilityMirror(undefined, true, "Alice"), {
    StatusSince: "now",
    AcknowledgedAt: null,
    AcknowledgedBy: null,
    EscalatedAt: null,
  });
});

test("acknowledge never collides with a transition (transition wins, no double-write)", () => {
  // Defensive: even if both were somehow set, the !isRealTransition guard means
  // AcknowledgedAt is only ever assigned once (to NULL, by the transition).
  const mirror = accountabilityMirror("acknowledged", true, "Alice");
  assert.strictEqual(mirror.AcknowledgedAt, null);
  assert.strictEqual(mirror.AcknowledgedBy, null);
  assert.strictEqual(mirror.StatusSince, "now");
});

test("a plain note (no event type, no transition) touches no accountability columns", () => {
  assert.deepStrictEqual(accountabilityMirror(undefined, false, "Alice"), {});
});

test("computeIsRealTransition: status move is real", () => {
  assert.strictEqual(
    computeIsRealTransition(
      { status: "New", awaitingRole: "facilities" },
      { status: "Quote", awaitingRole: "facilities" },
    ),
    true,
  );
});

test("computeIsRealTransition: awaitingRole-only move is real", () => {
  assert.strictEqual(
    computeIsRealTransition(
      { status: "Work", awaitingRole: "facilities" },
      { status: "Awaiting Approval", awaitingRole: "accounts" },
    ),
    true,
  );
});

test("computeIsRealTransition: self-transition is NOT real (no clock reset)", () => {
  assert.strictEqual(
    computeIsRealTransition(
      { status: "Awaiting Approval", awaitingRole: "facilities" },
      { status: "Awaiting Approval", awaitingRole: "facilities" },
    ),
    false,
  );
});

// ── WP18a: D1 close-path InvoiceID threading ─────────────────────────────────
// The JobEvents INSERT now includes InvoiceID. Mirror the param-build to prove
// the value (or null) is threaded through.

/** Mirrors the InvoiceID param on the addJobEvent JobEvents INSERT. */
function invoiceIdParam(invoiceId: number | undefined): number | null {
  return invoiceId ?? null;
}

test("InvoiceID threads into the event param when provided", () => {
  assert.strictEqual(invoiceIdParam(42), 42);
});

test("InvoiceID defaults to null when omitted", () => {
  assert.strictEqual(invoiceIdParam(undefined), null);
});
