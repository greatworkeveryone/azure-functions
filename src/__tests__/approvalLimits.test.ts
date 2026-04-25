import { describe, test } from "node:test";
import assert from "node:assert";
import { canApproveAmount, ApprovalLimit } from "../functions/invoices";

const LIMITS: ApprovalLimit[] = [
  { RoleName: "facilities_staff",   MaxInvoiceAmount: 1000.00 },
  { RoleName: "facilities_manager", MaxInvoiceAmount: 10000.00 },
  { RoleName: "accounts",           MaxInvoiceAmount: null },
  { RoleName: "Admin",              MaxInvoiceAmount: null },
];

describe("canApproveAmount", () => {
  test("facilities_staff with $1000 limit can approve a $999 invoice", () => {
    assert.strictEqual(
      canApproveAmount(["facilities_staff"], LIMITS, 999),
      true,
    );
  });

  test("facilities_staff with $1000 limit can approve exactly $1000", () => {
    assert.strictEqual(
      canApproveAmount(["facilities_staff"], LIMITS, 1000),
      true,
    );
  });

  test("facilities_staff with $1000 limit cannot approve a $1001 invoice", () => {
    assert.strictEqual(
      canApproveAmount(["facilities_staff"], LIMITS, 1001),
      false,
    );
  });

  test("facilities_manager with $10000 limit can approve a $9999 invoice", () => {
    assert.strictEqual(
      canApproveAmount(["facilities_manager"], LIMITS, 9999),
      true,
    );
  });

  test("facilities_manager cannot approve $10001 invoice", () => {
    assert.strictEqual(
      canApproveAmount(["facilities_manager"], LIMITS, 10001),
      false,
    );
  });

  test("Admin with null (unlimited) limit can approve any amount", () => {
    assert.strictEqual(canApproveAmount(["Admin"], LIMITS, 999999999), true);
  });

  test("accounts with null (unlimited) limit can approve any amount", () => {
    assert.strictEqual(canApproveAmount(["accounts"], LIMITS, 999999999), true);
  });

  test("user with multiple roles uses the highest limit", () => {
    // facilities_staff = 1000, facilities_manager = 10000 → effective = 10000
    assert.strictEqual(
      canApproveAmount(["facilities_staff", "facilities_manager"], LIMITS, 9999),
      true,
    );
    assert.strictEqual(
      canApproveAmount(["facilities_staff", "facilities_manager"], LIMITS, 10001),
      false,
    );
  });

  test("user with a limited role and an unlimited role gets unlimited authority", () => {
    // facilities_staff = 1000, accounts = null → effective = unlimited
    assert.strictEqual(
      canApproveAmount(["facilities_staff", "accounts"], LIMITS, 999999),
      true,
    );
  });

  test("user with no matching roles is denied", () => {
    assert.strictEqual(
      canApproveAmount(["unknown_role"], LIMITS, 1),
      false,
    );
  });

  test("empty roles list is denied", () => {
    assert.strictEqual(canApproveAmount([], LIMITS, 0), false);
  });

  test("empty limits list is denied even for a known role name", () => {
    assert.strictEqual(
      canApproveAmount(["facilities_staff"], [], 999),
      false,
    );
  });
});
