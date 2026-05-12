import { describe, test } from "node:test";
import assert from "node:assert";
import { requiresDirectorApproval } from "../functions/invoices";

describe("requiresDirectorApproval", () => {
  test("pending → false (still waiting on stage 1)", () => {
    assert.strictEqual(requiresDirectorApproval({ status: "pending" }), false);
  });

  test("approved → true (waiting on director)", () => {
    assert.strictEqual(requiresDirectorApproval({ status: "approved" }), true);
  });

  test("director_approved → false (stage 2 done)", () => {
    assert.strictEqual(requiresDirectorApproval({ status: "director_approved" }), false);
  });

  test("rejected → false (terminal)", () => {
    assert.strictEqual(requiresDirectorApproval({ status: "rejected" }), false);
  });
});
