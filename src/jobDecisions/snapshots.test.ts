/// <reference types="jest" />
import { decisionEventText, decisionSnapshot, darwinDay } from "./snapshots";
import type { DecisionRow } from "./decisionsStore";

const row = (over: Partial<DecisionRow> = {}): DecisionRow => ({
  decisionId: 4,
  deferUntil: null,
  jobId: 12,
  nextStep: "Pay the invoice\nand file the receipt",
  nextStepClosed: null,
  nextStepDueAt: new Date("2026-10-19T07:30:00Z"),
  nextStepOwnerRole: null,
  nextStepOwnerUserId: 9,
  outcome: "approve",
  rationale: "The lighting was ordered twice.",
  reaskRequestId: null,
  requestId: 7,
  respondedAt: new Date("2026-10-12T00:30:00Z"),
  respondedById: 5,
  respondedByName: "Dee",
  rowVersion: "AAAAAAAAAAc=",
  ...over,
});

describe("decisionSnapshot", () => {
  it("keeps the decision as it was made: outcome, rationale, who, the step and when it is due", () => {
    expect(decisionSnapshot(row())).toEqual({
      decisionId: 4,
      deferUntil: null,
      jobId: 12,
      nextStep: { closed: null, dueAt: "2026-10-19T07:30:00.000Z", ownerRole: null, ownerUserId: 9, text: "Pay the invoice\nand file the receipt" },
      outcome: "approve",
      rationale: "The lighting was ordered twice.",
      reaskRequestId: null,
      requestId: 7,
      respondedAt: "2026-10-12T00:30:00.000Z",
      respondedBy: { name: "Dee", userId: 5 },
    });
  });

  it("keeps how a step ended", () => {
    const closed = { at: new Date("2026-10-14T01:00:00Z"), byId: 9, byName: "Alana", kind: "done" as const, note: "Paid" };
    expect(decisionSnapshot(row({ nextStepClosed: closed }))).toMatchObject({
      nextStep: { closed: { at: "2026-10-14T01:00:00.000Z", by: "Alana", kind: "done", note: "Paid" } },
    });
  });

  it("has no step for a deferral without one, adds what it is given, and fits the ledger's limit with room to spare", () => {
    const snapshot = decisionSnapshot(row({ deferUntil: "2026-10-23", nextStep: null, nextStepDueAt: null, nextStepOwnerUserId: null, outcome: "defer" }), { answeredAs: "named" });
    expect(snapshot).toMatchObject({ answeredAs: "named", deferUntil: "2026-10-23", nextStep: null, outcome: "defer" });
    const biggest = row({ nextStep: "x".repeat(2000), rationale: "y".repeat(2000) });
    expect(Buffer.byteLength(JSON.stringify(decisionSnapshot(biggest)), "utf8")).toBeLessThan(64 * 1024);
  });
});

describe("decisionEventText", () => {
  it("says what was decided, by whom and why, and what happens next, on one line each", () => {
    expect(decisionEventText(row(), "Alana")).toBe(
      "Approved by Dee: The lighting was ordered twice.\nNext step for Alana, due 19/10/2026: Pay the invoice and file the receipt",
    );
  });

  it.each([
    ["deny", "Denied"],
    ["revise", "Revisions requested"],
    ["defer", "Deferred"],
  ] as const)("says %s as %s", (outcome, label) => {
    expect(decisionEventText(row({ outcome }), "Alana")).toMatch(new RegExp(`^${label} by Dee:`));
  });

  it("says when a deferred question comes back, day first, and needs no step", () => {
    const text = decisionEventText(row({ deferUntil: "2026-10-23", nextStep: null, nextStepDueAt: null, outcome: "defer" }), null);
    expect(text).toBe("Deferred by Dee: The lighting was ordered twice.\nThe question comes back on 23/10/2026.");
  });

  it("names a role by its label as the owner, and gives the Darwin day, not the UTC one", () => {
    expect(decisionEventText(row({ nextStepDueAt: new Date("2026-10-19T14:45:00Z") }), "Accounts")).toContain("Next step for Accounts, due 20/10/2026:");
    expect(darwinDay(new Date("2026-10-19T14:45:00Z"))).toBe("20/10/2026");
  });
});
