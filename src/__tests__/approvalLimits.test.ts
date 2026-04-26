import { describe, test } from "node:test";
import assert from "node:assert";
import { canApproveAmount, ApprovalLimit } from "../functions/invoices";

const LIMITS: ApprovalLimit[] = [
  { RoleName: "facilities",                    MaxInvoiceAmount: 1000.00 },
  { RoleName: "timesheet_approval_facilities", MaxInvoiceAmount: 10000.00 },
  { RoleName: "timesheet_approval_accounts",   MaxInvoiceAmount: 10000.00 },
  { RoleName: "accounts",                      MaxInvoiceAmount: 1000.00 },
  { RoleName: "Admin",                         MaxInvoiceAmount: null },
];

describe("canApproveAmount", () => {
  test("facilities with $1000 limit can approve a $999 invoice", () => {
    assert.strictEqual(
      canApproveAmount(["facilities"], LIMITS, 999),
      true,
    );
  });

  test("facilities with $1000 limit can approve exactly $1000", () => {
    assert.strictEqual(
      canApproveAmount(["facilities"], LIMITS, 1000),
      true,
    );
  });

  test("facilities with $1000 limit cannot approve a $1001 invoice", () => {
    assert.strictEqual(
      canApproveAmount(["facilities"], LIMITS, 1001),
      false,
    );
  });

  test("timesheet_approval_facilities with $10000 limit can approve a $9999 invoice", () => {
    assert.strictEqual(
      canApproveAmount(["timesheet_approval_facilities"], LIMITS, 9999),
      true,
    );
  });

  test("timesheet_approval_facilities cannot approve $10001 invoice", () => {
    assert.strictEqual(
      canApproveAmount(["timesheet_approval_facilities"], LIMITS, 10001),
      false,
    );
  });

  test("Admin with null (unlimited) limit can approve any amount", () => {
    assert.strictEqual(canApproveAmount(["Admin"], LIMITS, 999999999), true);
  });

  test("accounts with $1000 limit cannot approve a $1001 invoice", () => {
    assert.strictEqual(canApproveAmount(["accounts"], LIMITS, 1001), false);
  });

  test("accounts with $1000 limit can approve exactly $1000", () => {
    assert.strictEqual(canApproveAmount(["accounts"], LIMITS, 1000), true);
  });

  test("user with multiple roles uses the highest limit", () => {
    // facilities = 1000, timesheet_approval_facilities = 10000 → effective = 10000
    assert.strictEqual(
      canApproveAmount(["facilities", "timesheet_approval_facilities"], LIMITS, 9999),
      true,
    );
    assert.strictEqual(
      canApproveAmount(["facilities", "timesheet_approval_facilities"], LIMITS, 10001),
      false,
    );
  });

  test("user with a limited role and an unlimited role gets unlimited authority", () => {
    // facilities = 1000, Admin = null → effective = unlimited
    assert.strictEqual(
      canApproveAmount(["facilities", "Admin"], LIMITS, 999999),
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
      canApproveAmount(["facilities"], [], 999),
      false,
    );
  });
});
