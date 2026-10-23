/// <reference types="jest" />
// The lease_event escalation adapter: when each lease escalation's condition
// still holds, where it links, and who may withdraw it.
import { leaseConditionActive, leaseEventAdapter } from "../escalation/adapters/leaseEvent";

const TODAY = "2026-10-23";

describe("leaseConditionActive", () => {
  const live = { deadlineOn: "2026-11-10", state: "window_open" as const, tenancyClosed: false };

  it("keeps a deadline warning while the window is open with no notice, inside 30 days", () => {
    expect(leaseConditionActive("lease.option_deadline", live, TODAY)).toBe(true);
    expect(leaseConditionActive("lease.option_deadline", { ...live, state: "awaiting_approval" }, TODAY)).toBe(false);
    expect(leaseConditionActive("lease.option_deadline", { ...live, deadlineOn: "2026-12-30" }, TODAY)).toBe(false);
    expect(leaseConditionActive("lease.option_deadline", { ...live, deadlineOn: "2026-10-22" }, TODAY)).toBe(false);
  });

  it("keeps a lapse until a late notice is recorded, and a renewal until it is decided", () => {
    expect(leaseConditionActive("lease.option_lapsed", { ...live, state: "lapsed" }, TODAY)).toBe(true);
    expect(leaseConditionActive("lease.option_lapsed", { ...live, state: "notice_received" }, TODAY)).toBe(false);
    expect(leaseConditionActive("lease.renewal", { ...live, state: "referred" }, TODAY)).toBe(true);
    expect(leaseConditionActive("lease.renewal", { ...live, state: "holdover" }, TODAY)).toBe(false);
  });

  it("clears everything once the tenancy has gone", () => {
    expect(leaseConditionActive("lease.option_deadline", { ...live, tenancyClosed: true }, TODAY)).toBe(false);
  });
});

describe("leaseEventAdapter", () => {
  it("links to the tenancy's lease events and keeps the renewal referral from being withdrawn by hand", () => {
    expect(leaseEventAdapter.deepLink("ev-1", { context: { tenantId: 7 }, policyKey: "lease.renewal" })).toBe("/tenancy/7#lease-events");
    expect(leaseEventAdapter.withdrawable?.({ kind: "authority", policyKey: "lease.renewal" })).toBe(false);
    expect(leaseEventAdapter.withdrawable?.({ kind: "attention", policyKey: "lease.option_lapsed" })).toBe(true);
    expect(leaseEventAdapter.visibleTo({ name: "F", roles: ["facilities"], userId: 1 }, { policyKey: "lease.renewal", subjectId: "ev-1", subjectType: "lease_event" })).toBe(false);
    expect(leaseEventAdapter.visibleTo({ name: "A", roles: ["accounts"], userId: 1 }, { policyKey: "lease.renewal", subjectId: "ev-1", subjectType: "lease_event" })).toBe(true);
  });
});
