import { describe, expect, it } from "@jest/globals";
import {
  adminRefusal,
  amountRefusal,
  approvableRefusal,
  creatorRefusal,
  declineReasonRefusal,
  jobMoneyRefusal,
  purchaseOrderCostRefusal,
  purchaseOrderQuoteRefusal,
  REJECT_REASON_MAX,
  rejectReason,
  samePerson,
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

  it("decision 18: an outgoing (on-charge) invoice is still allowed on a done job, but not on an internal or archived one", () => {
    expect(jobMoneyRefusal({ isInternal: false, status: "Done" }, { outgoingInvoice: true })).toBeNull();
    expect(jobMoneyRefusal({ isInternal: true, status: "Done" }, { outgoingInvoice: true })?.code).toBe("internal_job");
    expect(jobMoneyRefusal({ isArchived: true, status: "Work" }, { outgoingInvoice: true })?.code).toBe("job_archived");
  });
});

describe("jobMoneyRefusal: admin jobs (A0)", () => {
  const ADMIN = { code: "admin_is_internal", message: "This is an admin job: it has no quotes, orders or invoices.", status: 422 };

  it("refuses an admin job, in plain words, whatever its other flags say", () => {
    expect(jobMoneyRefusal({ isInternal: false, kind: "admin", status: "Work" })).toEqual(ADMIN);
    expect(jobMoneyRefusal({ isInternal: true, kind: "admin", status: "Work" })).toEqual(ADMIN);
  });

  it("answers before the done, archived and internal rules, so the person is told the real reason", () => {
    expect(jobMoneyRefusal({ isArchived: true, isInternal: true, kind: "admin", status: "Done" })).toEqual(ADMIN);
  });

  it("refuses an admin job's outgoing invoice too: the kind has no money flow at all", () => {
    expect(jobMoneyRefusal({ kind: "admin", status: "Done" }, { outgoingInvoice: true })).toEqual(ADMIN);
  });

  it("lets the contractor-flow kinds through, and a job whose kind was not loaded reads as facilities", () => {
    expect(jobMoneyRefusal({ kind: "facilities", status: "Work" })).toBeNull();
    expect(jobMoneyRefusal({ kind: "maintenance", status: "Work" })).toBeNull();
    expect(jobMoneyRefusal({ kind: " ", status: "Work" })).toBeNull();
    expect(jobMoneyRefusal({ status: "Work" })).toBeNull();
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

  it("refuses the creator as approver", () => {
    expect(creatorRefusal("Abby Accounts", { name: "Abby Accounts", roles: ["accounts_manager"] }, "quote")).toEqual({
      code: "creator",
      message: "You added this quote, so someone else has to approve it.",
      status: 403,
    });
    expect(creatorRefusal("Abby Accounts", { name: "Casey Controller", roles: ["accounts_manager"] }, "invoice")).toBeNull();
  });

  it("decision 17: never blocks a director", () => {
    expect(creatorRefusal("Dana Director", { name: "Dana Director", roles: ["director"] }, "quote")).toBeNull();
    expect(creatorRefusal("Dana Director", { name: "Dana Director", roles: [" Director "] }, "invoice")).toBeNull();
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

describe("purchase orders", () => {
  it("rest on an approved quote in every job state, contract jobs excepted", () => {
    expect(purchaseOrderQuoteRefusal({ hasApprovedQuote: false, isContract: false })?.code).toBe("quote_not_approved");
    expect(purchaseOrderQuoteRefusal({ hasApprovedQuote: true, isContract: false })).toBeNull();
    expect(purchaseOrderQuoteRefusal({ hasApprovedQuote: false, isContract: true })).toBeNull();
  });

  it("need a cost above $0 when raised, and any cost sent must be above $0", () => {
    expect(purchaseOrderCostRefusal(undefined, undefined, true)?.code).toBe("amount_invalid");
    expect(purchaseOrderCostRefusal(undefined, 4500, true)).toBeNull();
    expect(purchaseOrderCostRefusal(0, 4500, true)?.code).toBe("amount_invalid");
    expect(purchaseOrderCostRefusal(undefined, undefined, false)).toBeNull();
    expect(purchaseOrderCostRefusal(null, undefined, false)?.code).toBe("amount_invalid");
  });
});

describe("declining at the director stage needs a reason (J6)", () => {
  it("refuses a decline of something waiting on a director without a reason, naming the record", () => {
    expect(declineReasonRefusal(true, null, "quote")).toEqual({
      code: "reason_required",
      message: "Say why you're declining this quote. The reason is recorded on the job for whoever raised it.",
      status: 422,
    });
    expect(declineReasonRefusal(true, null, "invoice")?.message).toContain("this invoice");
  });

  it("lets it through with a reason, and lets any rejection before the director stage through without one", () => {
    expect(declineReasonRefusal(true, "Too dear", "quote")).toBeNull();
    expect(declineReasonRefusal(false, null, "invoice")).toBeNull();
  });

  it("reads a reason from a body: trimmed, cut to length, and nothing for blanks or non-strings", () => {
    expect(rejectReason("  Too dear  ")).toBe("Too dear");
    expect(rejectReason("x".repeat(REJECT_REASON_MAX + 50))).toHaveLength(REJECT_REASON_MAX);
    for (const blank of ["", "   ", undefined, null, 42, {}]) expect(rejectReason(blank)).toBeNull();
  });
});
