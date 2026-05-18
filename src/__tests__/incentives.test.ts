import assert from "node:assert";
import {
  deleteIncentive,
  NOT_FOUND,
  parseIncentives,
  TenancyIncentive,
  upsertIncentive,
  validateDeleteEnvelope,
  validateIncentive,
  validateUpsertEnvelope,
} from "../incentiveLogic";
import { _resetRateLimitForTests, checkRateLimit } from "../rateLimit";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";

// ── Rate limiter ─────────────────────────────────────────────────────────────

describe("checkRateLimit", () => {
  beforeEach(() => {
    _resetRateLimitForTests();
  });

  test("allows requests under the configured limit", () => {
    for (let i = 0; i < 3; i++) {
      const result = checkRateLimit("user-a", { limit: 3, windowMs: 1000 });
      assert.deepStrictEqual(result, { allowed: true });
    }
  });

  test("blocks the request that exceeds the limit and returns retry-after ms", () => {
    for (let i = 0; i < 3; i++) {
      checkRateLimit("user-b", { limit: 3, windowMs: 1000 });
    }
    const blocked = checkRateLimit("user-b", { limit: 3, windowMs: 1000 });
    assert.strictEqual(blocked.allowed, false);
    if (blocked.allowed === false) {
      assert.ok(blocked.retryAfterMs > 0);
      assert.ok(blocked.retryAfterMs <= 1000);
    }
  });

  test("resets after the window expires", async () => {
    for (let i = 0; i < 2; i++) {
      checkRateLimit("user-c", { limit: 2, windowMs: 50 });
    }
    const blocked = checkRateLimit("user-c", { limit: 2, windowMs: 50 });
    assert.strictEqual(blocked.allowed, false);

    await new Promise((resolve) => setTimeout(resolve, 60));

    const allowed = checkRateLimit("user-c", { limit: 2, windowMs: 50 });
    assert.deepStrictEqual(allowed, { allowed: true });
  });

  test("isolates keys from each other", () => {
    for (let i = 0; i < 5; i++) {
      checkRateLimit("user-d", { limit: 5, windowMs: 1000 });
    }
    const blockedD = checkRateLimit("user-d", { limit: 5, windowMs: 1000 });
    assert.strictEqual(blockedD.allowed, false);
    const allowedE = checkRateLimit("user-e", { limit: 5, windowMs: 1000 });
    assert.deepStrictEqual(allowedE, { allowed: true });
  });
});

// ── Validator: happy paths ───────────────────────────────────────────────────

describe("validateIncentive — accepts valid shapes", () => {
  test("rentFreeMonths with all fields", () => {
    const result = validateIncentive({
      id: UUID_A,
      kind: "rentFreeMonths",
      freeMonthsFromStart: 3,
      note: "Two weeks of free rent for fitout",
    });
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.incentive.id, UUID_A);
      assert.strictEqual(result.incentive.kind, "rentFreeMonths");
      assert.strictEqual(result.incentive.freeMonthsFromStart, 3);
      assert.strictEqual(result.incentive.note, "Two weeks of free rent for fitout");
    }
  });

  test("monthlyReduction with reductionMonths", () => {
    const result = validateIncentive({
      kind: "monthlyReduction",
      reductionAmount: 500,
      reductionMonths: 6,
    });
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.incentive.kind, "monthlyReduction");
      assert.strictEqual(result.incentive.reductionAmount, 500);
      assert.strictEqual(result.incentive.reductionMonths, 6);
    }
  });

  test("monthlyReduction with reductionMonths=null (whole lease)", () => {
    const result = validateIncentive({
      kind: "monthlyReduction",
      reductionAmount: 250.5,
      reductionMonths: null,
    });
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.incentive.reductionMonths, null);
    }
  });

  test("generates a UUID when id is missing", () => {
    const result = validateIncentive({
      kind: "rentFreeMonths",
      freeMonthsFromStart: 1,
    });
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.match(result.incentive.id, /^[0-9a-f-]{36}$/i);
    }
  });

  test("generates a UUID when id is empty string", () => {
    const result = validateIncentive({
      id: "",
      kind: "rentFreeMonths",
      freeMonthsFromStart: 1,
    });
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.notStrictEqual(result.incentive.id, "");
      assert.match(result.incentive.id, /^[0-9a-f-]{36}$/i);
    }
  });
});

// ── Validator: each failure mode (one assertion per case) ────────────────────

describe("validateIncentive — rejects each invalid case", () => {
  test("rejects non-object", () => {
    const result = validateIncentive("not-an-object");
    assert.strictEqual(result.ok, false);
  });

  test("rejects null", () => {
    const result = validateIncentive(null);
    assert.strictEqual(result.ok, false);
  });

  test("rejects unknown keys", () => {
    const result = validateIncentive({
      kind: "rentFreeMonths",
      freeMonthsFromStart: 3,
      somethingElse: "no",
    });
    assert.strictEqual(result.ok, false);
  });

  test("rejects bad kind", () => {
    const result = validateIncentive({ kind: "something" });
    assert.strictEqual(result.ok, false);
  });

  test("rejects rentFreeMonths with freeMonthsFromStart below range", () => {
    const result = validateIncentive({
      kind: "rentFreeMonths",
      freeMonthsFromStart: 0,
    });
    assert.strictEqual(result.ok, false);
  });

  test("rejects rentFreeMonths with freeMonthsFromStart above range", () => {
    const result = validateIncentive({
      kind: "rentFreeMonths",
      freeMonthsFromStart: 61,
    });
    assert.strictEqual(result.ok, false);
  });

  test("rejects rentFreeMonths with non-integer freeMonthsFromStart", () => {
    const result = validateIncentive({
      kind: "rentFreeMonths",
      freeMonthsFromStart: 3.5,
    });
    assert.strictEqual(result.ok, false);
  });

  test("rejects rentFreeMonths carrying reductionAmount", () => {
    const result = validateIncentive({
      kind: "rentFreeMonths",
      freeMonthsFromStart: 3,
      reductionAmount: 100,
    });
    assert.strictEqual(result.ok, false);
  });

  test("rejects rentFreeMonths carrying reductionMonths", () => {
    const result = validateIncentive({
      kind: "rentFreeMonths",
      freeMonthsFromStart: 3,
      reductionMonths: 5,
    });
    assert.strictEqual(result.ok, false);
  });

  test("rejects monthlyReduction with reductionAmount of 0", () => {
    const result = validateIncentive({
      kind: "monthlyReduction",
      reductionAmount: 0,
    });
    assert.strictEqual(result.ok, false);
  });

  test("rejects monthlyReduction with negative reductionAmount", () => {
    const result = validateIncentive({
      kind: "monthlyReduction",
      reductionAmount: -10,
    });
    assert.strictEqual(result.ok, false);
  });

  test("rejects monthlyReduction with reductionAmount over cap", () => {
    const result = validateIncentive({
      kind: "monthlyReduction",
      reductionAmount: 1_000_001,
    });
    assert.strictEqual(result.ok, false);
  });

  test("rejects monthlyReduction with infinite reductionAmount", () => {
    const result = validateIncentive({
      kind: "monthlyReduction",
      reductionAmount: Number.POSITIVE_INFINITY,
    });
    assert.strictEqual(result.ok, false);
  });

  test("rejects monthlyReduction with reductionMonths below range", () => {
    const result = validateIncentive({
      kind: "monthlyReduction",
      reductionAmount: 100,
      reductionMonths: 0,
    });
    assert.strictEqual(result.ok, false);
  });

  test("rejects monthlyReduction with reductionMonths above range", () => {
    const result = validateIncentive({
      kind: "monthlyReduction",
      reductionAmount: 100,
      reductionMonths: 61,
    });
    assert.strictEqual(result.ok, false);
  });

  test("rejects monthlyReduction carrying freeMonthsFromStart", () => {
    const result = validateIncentive({
      kind: "monthlyReduction",
      reductionAmount: 100,
      freeMonthsFromStart: 1,
    });
    assert.strictEqual(result.ok, false);
  });

  test("rejects non-string note", () => {
    const result = validateIncentive({
      kind: "rentFreeMonths",
      freeMonthsFromStart: 1,
      note: 42,
    });
    assert.strictEqual(result.ok, false);
  });

  test("rejects note longer than 500 chars", () => {
    const result = validateIncentive({
      kind: "rentFreeMonths",
      freeMonthsFromStart: 1,
      note: "a".repeat(501),
    });
    assert.strictEqual(result.ok, false);
  });

  test("rejects malformed id", () => {
    const result = validateIncentive({
      id: "not-a-uuid",
      kind: "rentFreeMonths",
      freeMonthsFromStart: 1,
    });
    assert.strictEqual(result.ok, false);
  });
});

// ── Envelope validators ──────────────────────────────────────────────────────

describe("validateUpsertEnvelope", () => {
  test("accepts a valid envelope", () => {
    const result = validateUpsertEnvelope({
      TenantId: 1,
      BuildingId: 2,
      incentive: { kind: "rentFreeMonths", freeMonthsFromStart: 3 },
    });
    assert.strictEqual(result.ok, true);
  });

  test("rejects non-positive TenantId", () => {
    const result = validateUpsertEnvelope({
      TenantId: 0,
      BuildingId: 2,
      incentive: { kind: "rentFreeMonths", freeMonthsFromStart: 3 },
    });
    assert.strictEqual(result.ok, false);
  });

  test("rejects non-integer BuildingId", () => {
    const result = validateUpsertEnvelope({
      TenantId: 1,
      BuildingId: 2.5,
      incentive: { kind: "rentFreeMonths", freeMonthsFromStart: 3 },
    });
    assert.strictEqual(result.ok, false);
  });

  test("rejects when incentive is missing", () => {
    const result = validateUpsertEnvelope({ TenantId: 1, BuildingId: 2 });
    assert.strictEqual(result.ok, false);
  });
});

describe("validateDeleteEnvelope", () => {
  test("accepts a valid envelope", () => {
    const result = validateDeleteEnvelope({
      TenantId: 1,
      BuildingId: 2,
      incentiveId: UUID_A,
    });
    assert.strictEqual(result.ok, true);
  });

  test("rejects non-UUID incentiveId", () => {
    const result = validateDeleteEnvelope({
      TenantId: 1,
      BuildingId: 2,
      incentiveId: "nope",
    });
    assert.strictEqual(result.ok, false);
  });
});

// ── upsertIncentive (pure array fn) ──────────────────────────────────────────

describe("upsertIncentive", () => {
  const rentFree: TenancyIncentive = {
    id: UUID_A,
    kind: "rentFreeMonths",
    freeMonthsFromStart: 3,
  };
  const monthlyRed: TenancyIncentive = {
    id: UUID_B,
    kind: "monthlyReduction",
    reductionAmount: 200,
  };

  test("appends a new incentive when no id matches", () => {
    const existing = [rentFree];
    const result = upsertIncentive(existing, monthlyRed);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[1].id, UUID_B);
  });

  test("replaces an existing incentive in place by id", () => {
    const existing = [rentFree, monthlyRed];
    const updated: TenancyIncentive = {
      id: UUID_A,
      kind: "rentFreeMonths",
      freeMonthsFromStart: 12,
    };
    const result = upsertIncentive(existing, updated);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].freeMonthsFromStart, 12);
    assert.strictEqual(result[1].id, UUID_B);
  });

  test("does not mutate the input array", () => {
    const existing = [rentFree];
    const before = JSON.stringify(existing);
    upsertIncentive(existing, monthlyRed);
    assert.strictEqual(JSON.stringify(existing), before);
  });
});

// ── deleteIncentive (pure array fn) ──────────────────────────────────────────

describe("deleteIncentive", () => {
  const a: TenancyIncentive = { id: UUID_A, kind: "rentFreeMonths", freeMonthsFromStart: 1 };
  const b: TenancyIncentive = { id: UUID_B, kind: "monthlyReduction", reductionAmount: 100 };

  test("removes the matching entry", () => {
    const result = deleteIncentive([a, b], UUID_A);
    assert.notStrictEqual(result, NOT_FOUND);
    if (result !== NOT_FOUND) {
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].id, UUID_B);
    }
  });

  test("returns NOT_FOUND when id is absent", () => {
    const result = deleteIncentive([a, b], UUID_C);
    assert.strictEqual(result, NOT_FOUND);
  });

  test("does not mutate the input array", () => {
    const existing = [a, b];
    const before = JSON.stringify(existing);
    deleteIncentive(existing, UUID_A);
    assert.strictEqual(JSON.stringify(existing), before);
  });
});

// ── parseIncentives ──────────────────────────────────────────────────────────

describe("parseIncentives", () => {
  test("returns empty array for null", () => {
    assert.deepStrictEqual(parseIncentives(null), []);
  });

  test("returns empty array for empty string", () => {
    assert.deepStrictEqual(parseIncentives(""), []);
  });

  test("returns empty array for malformed JSON", () => {
    assert.deepStrictEqual(parseIncentives("not-json{"), []);
  });

  test("returns empty array for non-array JSON", () => {
    assert.deepStrictEqual(parseIncentives('{"oops":true}'), []);
  });

  test("filters out entries that don't look like incentives", () => {
    const raw = JSON.stringify([
      { id: UUID_A, kind: "rentFreeMonths", freeMonthsFromStart: 1 },
      { id: UUID_B, kind: "garbage" },
      "not-an-object",
    ]);
    const result = parseIncentives(raw);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, UUID_A);
  });
});
