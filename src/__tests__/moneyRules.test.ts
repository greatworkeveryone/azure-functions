import { describe, expect, it } from "@jest/globals";
import {
  adminRefusal,
  amountRefusal,
  approvableRefusal,
  creatorRefusal,
  jobMoneyRefusal,
  samePerson,
  stageOneRefusal,
} from "../moneyRules";

// J3: the rules the money handlers share, on their own.

describe("jobMoneyRefusal", () => {
  it("lets a live job's money records change", () => {
    expect(jobMoneyRefusal({ isArchived: false, isInternal: false, status: "Work" })).toBeNull();
  });

  it("refuses internal, done and archived jobs, in that order", () => {
    expect(jobMoneyRefusal({ isInternal: true, status: "Done" })?.code).toBe("internal_job");
    expect(jobMoneyRefusal({ isInternal: false, status: "Done" })).toMatchObject({ code: "job_done", status: 409 });
    expect(jobMoneyRefusal({ isArchived: 1, status: "Work" })?.code).toBe("job_archived");
  });
});

describe("amountRefusal", () => {
  it.each([undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, "500"])("refuses %p when an amount is required", (value) => {
    expect(amountRefusal(value, "Amount", true)).toEqual({ code: "amount_invalid", message: "Amount is required and must be more than $0.", status: 422 });
  });

  it("accepts a positive amount, and an edit that leaves it out", () => {
    expect(amountRefusal(0.01, "Amount", true)).toBeNull();
    expect(amountRefusal(undefined, "Amount", false)).toBeNull();
  });

  it("refuses clearing an amount on an edit", () => {
    expect(amountRefusal(null, "Amount", false)?.code).toBe("amount_invalid");
  });
});

describe("separation of duties", () => {
  it("compares stored names trimmed and case-blind, never two blanks", () => {
    expect(samePerson(" Dana Director ", "dana director")).toBe(true);
    expect(samePerson("", "")).toBe(false);
    expect(samePerson(null, "Dana")).toBe(false);
  });

  it("refuses the creator as approver, and the first approver as director", () => {
    expect(creatorRefusal("Dana Director", "Dana Director", "quote")).toEqual({
      code: "creator",
      message: "You added this quote, so someone else has to approve it.",
      status: 403,
    });
    expect(creatorRefusal("Abby Accounts", "Dana Director", "invoice")).toBeNull();
    expect(stageOneRefusal("Dana Director", "Dana Director", "invoice")?.code).toBe("same_approver");
    expect(stageOneRefusal("Abby Accounts", "Dana Director", "invoice")).toBeNull();
  });
});

describe("approvableRefusal", () => {
  it.each(["pending", "awaiting_approval"])("approves from %s", (status) => {
    expect(approvableRefusal(status, "invoice")).toBeNull();
  });

  it.each(["approved", "director_approved", "rejected", "awaiting_director", "completed", null])("refuses from %p as stale", (status) => {
    expect(approvableRefusal(status, "invoice")).toMatchObject({ code: "not_approvable", status: 409 });
  });
});

describe("adminRefusal (decision 4)", () => {
  it("bars admin on real records and allows test records", () => {
    expect(adminRefusal(["admin"], false)).toMatchObject({ code: "admin_test_records_only", status: 403 });
    expect(adminRefusal([" Admin "], true)).toBeNull();
  });

  it("leaves other roles alone", () => {
    expect(adminRefusal(["accounts_manager"], false)).toBeNull();
    expect(adminRefusal(["admin", "accounts_manager"], false)).toBeNull();
  });
});
