import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { resolveRecipient } from "../email-recipient";

const OVERRIDE = "test@greatworkeveryone.com";

describe("resolveRecipient", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.DEV_EMAIL_OVERRIDE;
    delete process.env.DEV_EMAIL_OVERRIDE;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.DEV_EMAIL_OVERRIDE;
    else process.env.DEV_EMAIL_OVERRIDE = originalEnv;
  });

  test("passes the real address through when no override is set", () => {
    const result = resolveRecipient("real@contractor.example");
    assert.strictEqual(result.address, "real@contractor.example");
    assert.strictEqual(result.overridden, false);
    assert.strictEqual(result.original, "real@contractor.example");
  });

  test("returns null when no override and real address is missing", () => {
    const result = resolveRecipient(null);
    assert.strictEqual(result.address, null);
    assert.strictEqual(result.overridden, false);
    assert.strictEqual(result.original, null);
  });

  test("rewrites the address to the override when one is set", () => {
    process.env.DEV_EMAIL_OVERRIDE = OVERRIDE;
    const result = resolveRecipient("real@contractor.example");
    assert.strictEqual(result.address, OVERRIDE);
    assert.strictEqual(result.overridden, true);
    assert.strictEqual(result.original, "real@contractor.example");
  });

  test("uses the override even when real address is null (so dev sends still land somewhere)", () => {
    process.env.DEV_EMAIL_OVERRIDE = OVERRIDE;
    const result = resolveRecipient(null);
    assert.strictEqual(result.address, OVERRIDE);
    assert.strictEqual(result.overridden, true);
    assert.strictEqual(result.original, null);
  });

  test("does not flag overridden when real address already equals the override", () => {
    process.env.DEV_EMAIL_OVERRIDE = OVERRIDE;
    const result = resolveRecipient(OVERRIDE);
    assert.strictEqual(result.address, OVERRIDE);
    assert.strictEqual(result.overridden, false);
  });

  test("trims whitespace on both the real address and the override", () => {
    process.env.DEV_EMAIL_OVERRIDE = `  ${OVERRIDE}  `;
    const result = resolveRecipient("  real@contractor.example  ");
    assert.strictEqual(result.address, OVERRIDE);
    assert.strictEqual(result.original, "real@contractor.example");
    assert.strictEqual(result.overridden, true);
  });

  test("treats whitespace-only override as unset", () => {
    process.env.DEV_EMAIL_OVERRIDE = "   ";
    const result = resolveRecipient("real@contractor.example");
    assert.strictEqual(result.address, "real@contractor.example");
    assert.strictEqual(result.overridden, false);
  });

  test("treats whitespace-only real address as null", () => {
    const result = resolveRecipient("   ");
    assert.strictEqual(result.address, null);
    assert.strictEqual(result.original, null);
    assert.strictEqual(result.overridden, false);
  });
});
