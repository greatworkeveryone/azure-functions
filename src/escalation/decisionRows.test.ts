/// <reference types="jest" />
import { askedOfIds, decisionOf, DECISION_PENDING_POLICY, isDecisionPolicy, isDecisionRow, namedTargetIds, remindersOf } from "./decisionRows";
import type { EscalationRow } from "./types";

type Rowish = Pick<EscalationRow, "context" | "noIndependentTarget" | "policyKey" | "targetRole">;
const row = (over: Partial<Rowish> = {}): Rowish => ({
  context: null,
  noIndependentTarget: false,
  policyKey: DECISION_PENDING_POLICY,
  targetRole: null,
  ...over,
});

const decision = {
  assignmentMode: "named",
  callThem: false,
  jobLabel: "Job #12 · Superseded lighting invoice · 25 Temira Crescent",
  question: "Pay the superseded invoice?",
  requestId: 7,
  respondBy: "2026-10-20T07:30:00.000Z",
  tier: "soon",
};

describe("the decision policy", () => {
  it("is job.decision_pending, the key migration 137 seeds", () => {
    expect(DECISION_PENDING_POLICY).toBe("job.decision_pending");
    expect(isDecisionPolicy("job.decision_pending")).toBe(true);
    expect(isDecisionPolicy("job.manual")).toBe(false);
    expect(isDecisionPolicy("")).toBe(false);
  });

  it("marks a row by its policy key and nothing else", () => {
    expect(isDecisionRow(row())).toBe(true);
    expect(isDecisionRow(row({ policyKey: "job.decision_pending_x" }))).toBe(false);
    expect(isDecisionRow(row({ policyKey: "job.stalled_unacknowledged" }))).toBe(false);
  });
});

describe("decisionOf", () => {
  it("reads the block a request writes into the row's context", () => {
    expect(decisionOf(row({ context: { decision } }))).toEqual({
      assignmentMode: "named",
      callThem: false,
      jobLabel: "Job #12 · Superseded lighting invoice · 25 Temira Crescent",
      question: "Pay the superseded invoice?",
      reaskOf: null,
      requestId: 7,
      respondBy: new Date("2026-10-20T07:30:00.000Z"),
      tier: "soon",
    });
  });

  it("reads a deferred question coming round again: who first asked, which decision it follows and the day it was put off to", () => {
    const reaskOf = { askedBy: "Alana", decisionId: 4, deferredUntil: "2026-10-23" };
    expect(decisionOf(row({ context: { decision: { ...decision, reaskOf } } }))?.reaskOf).toEqual(reaskOf);
    expect(decisionOf(row({ context: { decision: { ...decision, reaskOf: { decisionId: 4, deferredUntil: "2026-10-23" } } } }))?.reaskOf).toEqual({
      askedBy: "",
      decisionId: 4,
      deferredUntil: "2026-10-23",
    });
  });

  it("reads no re-ask from a block that is not one", () => {
    for (const reaskOf of [null, "yes", 4, {}, { decisionId: "4", deferredUntil: "2026-10-23" }, { decisionId: 4 }]) {
      expect(decisionOf(row({ context: { decision: { ...decision, reaskOf } } }))?.reaskOf).toBeNull();
    }
  });

  it("reads an emergency, which has no deadline", () => {
    const note = decisionOf(row({ context: { decision: { ...decision, callThem: true, respondBy: null, tier: "emergency" } } }));
    expect(note).toMatchObject({ callThem: true, respondBy: null, tier: "emergency" });
  });

  it("reads a role-wide request", () => {
    expect(decisionOf(row({ context: { decision: { ...decision, assignmentMode: "role" } } }))?.assignmentMode).toBe("role");
  });

  it.each([
    ["no context", null],
    ["no decision block", { title: "Leaking roof" }],
    ["a decision that is not an object", { decision: "pay it" }],
    ["a decision with no question", { decision: { requestId: 7 } }],
    ["a decision with no request id", { decision: { question: "q" } }],
    ["a list", { decision: [decision] }],
  ])("gives null for %s", (_label, context) => {
    expect(decisionOf(row({ context }))).toBeNull();
  });

  it("gives null for a row that is not a decision request, whatever its context says", () => {
    expect(decisionOf(row({ context: { decision }, policyKey: "job.manual" }))).toBeNull();
  });

  it("ignores a respondBy that is not a date", () => {
    expect(decisionOf(row({ context: { decision: { ...decision, respondBy: "soon" } } }))?.respondBy).toBeNull();
  });
});

describe("remindersOf", () => {
  it("reads the scheduled times, ascending, and drops what is not a date", () => {
    const context = { schedule: { remindAt: ["2026-10-22T22:00:00.000Z", "2026-10-19T23:00:00.000Z", "not a date", 5, null] } };
    expect(remindersOf({ context }).map((d) => d.toISOString())).toEqual(["2026-10-19T23:00:00.000Z", "2026-10-22T22:00:00.000Z"]);
  });

  it.each([null, {}, { schedule: null }, { schedule: {} }, { schedule: { remindAt: "tomorrow" } }, { schedule: [] }])("is empty for %j", (context) => {
    expect(remindersOf({ context })).toEqual([]);
  });
});

describe("askedOfIds and namedTargetIds", () => {
  it("lists the people the row was raised to ask, once each", () => {
    expect(askedOfIds({ context: { userTargets: [3, 5, 5, 9] } })).toEqual([3, 5, 9]);
  });

  it("ignores anything in the list that is not a whole number", () => {
    expect(askedOfIds({ context: { userTargets: [3, "5", 4.5, null, 9] } })).toEqual([3, 9]);
    expect(askedOfIds({ context: { userTargets: "3" } })).toEqual([]);
    expect(askedOfIds({ context: null })).toEqual([]);
  });

  it("names the people a row is for when its level is a group of them: no role, no flag", () => {
    expect(namedTargetIds(row({ context: { userTargets: [3, 5] } }))).toEqual([3, 5]);
  });

  it("is empty once the row has a role: it has moved up, and the people it was asked of are no longer its audience", () => {
    expect(namedTargetIds(row({ context: { userTargets: [3, 5] }, targetRole: "accounts_manager" }))).toEqual([]);
    expect(askedOfIds({ context: { userTargets: [3, 5] } })).toEqual([3, 5]);
  });

  it("is empty for a row flagged for want of an independent target", () => {
    expect(namedTargetIds(row({ context: { userTargets: [3, 5] }, noIndependentTarget: true }))).toEqual([]);
  });

  it("is empty for a row with no named people", () => {
    expect(namedTargetIds(row({ context: { title: "Leaking roof" } }))).toEqual([]);
  });
});
