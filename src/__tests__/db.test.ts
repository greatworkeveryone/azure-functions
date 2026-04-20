import { describe, test } from "node:test";
import assert from "node:assert";
import { TYPES } from "tedious";
import { buildUpdateSet } from "../db";

describe("buildUpdateSet", () => {
  const ALLOWLIST = {
    Amount: TYPES.Decimal,
    Notes: TYPES.NVarChar,
    PaidBy: TYPES.NVarChar,
  };

  test("emits one `Col = @Col` clause per provided field, in allowlist order", () => {
    const result = buildUpdateSet(ALLOWLIST, {
      Notes: "hi",
      PaidBy: "Alice",
    });
    assert.ok(result);
    assert.strictEqual(result.setClause, "Notes = @Notes, PaidBy = @PaidBy");
    assert.deepStrictEqual(
      result.params.map((p) => p.name),
      ["Notes", "PaidBy"],
    );
  });

  test("binds values via params (SQL never contains the value)", () => {
    const result = buildUpdateSet(ALLOWLIST, { Amount: 42 });
    assert.ok(result);
    assert.doesNotMatch(result.setClause, /42/);
    assert.strictEqual(result.params[0].value, 42);
    assert.strictEqual(result.params[0].type, TYPES.Decimal);
  });

  test("skips undefined values entirely (column untouched)", () => {
    const result = buildUpdateSet(ALLOWLIST, {
      Amount: undefined,
      Notes: "x",
    });
    assert.ok(result);
    assert.strictEqual(result.setClause, "Notes = @Notes");
    assert.strictEqual(result.params.length, 1);
  });

  test("converts null to SQL NULL via the param value", () => {
    const result = buildUpdateSet(ALLOWLIST, { Notes: null });
    assert.ok(result);
    assert.strictEqual(result.params[0].value, null);
  });

  test("returns null when no allowlisted field is provided", () => {
    assert.strictEqual(buildUpdateSet(ALLOWLIST, {}), null);
    assert.strictEqual(
      buildUpdateSet(ALLOWLIST, { Amount: undefined }),
      null,
    );
  });

  // ── The security property ──────────────────────────────────────────────
  // These are the tests that prove the helper is injection-resistant.

  test("silently drops keys not in the allowlist", () => {
    const hostile = {
      Amount: 10,
      // These keys should never appear in the output — they aren't in the allowlist.
      "; DROP TABLE Payments; --": "x" as any,
      __proto__: "x" as any,
      constructor: "x" as any,
      Password: "x" as any,
    };
    const result = buildUpdateSet(ALLOWLIST, hostile as any);
    assert.ok(result);
    assert.strictEqual(result.setClause, "Amount = @Amount");
    assert.strictEqual(result.params.length, 1);
  });

  test("a fields object of only disallowed keys returns null", () => {
    const result = buildUpdateSet(ALLOWLIST, {
      "; DROP TABLE --": 1,
      SomeOtherColumn: "x",
    } as any);
    assert.strictEqual(result, null);
  });

  test("allowlist column names are emitted verbatim (no quoting)", () => {
    // Trust boundary check: the helper assumes allowlist keys are safe
    // identifier strings. We never want to encourage callers to pass
    // user-controlled strings as allowlist keys, so the helper does not
    // quote or escape them — if the allowlist is clean, so is the SQL.
    const result = buildUpdateSet({ Foo: TYPES.Int }, { Foo: 1 });
    assert.ok(result);
    assert.strictEqual(result.setClause, "Foo = @Foo");
  });
});
