/// <reference types="jest" />
// A rent review's escalations (PLAN §3.4): when E1, E2 and E3 hold, when the
// generator raises them again (never what a person closed), how a decision ends
// them (with its own code; a cancel withdraws), and the generator's step in live
// and dry-run modes. The engine is mocked: its own tests cover raise and conclude.
import type { Connection } from "tedious";
import { addDaysIso, todayInDarwin } from "../darwinDate";
import {
  approvalOutcomeCode,
  NOT_COMMENCED_LEAD_DAYS,
  REVIEW_POLICIES,
  reviewConditionActive,
  shouldRaise,
} from "../rentReview/escalationRules";
import {
  approvalHeadline,
  historyKey,
  planReviewEscalations,
  raiseApprovalEscalation,
  runReviewEscalations,
  separationOfDuties,
  settleReviewEscalations,
  type OpenReviewFacts,
} from "../rentReview/escalations";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));
jest.mock("../escalation", () => {
  const actual = jest.requireActual("../escalation/errors");
  return { concludeForSubject: jest.fn(), EscalationError: actual.EscalationError, raise: jest.fn() };
});
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn() } }));

const db = require("../db") as { executeQuery: jest.Mock };
const engine = require("../escalation") as { concludeForSubject: jest.Mock; raise: jest.Mock };
const { EscalationError } = jest.requireActual("../escalation/errors") as typeof import("../escalation/errors");
const { Sentry } = require("../sentry") as { Sentry: { captureException: jest.Mock } };

const conn = {} as Connection;
const TODAY = todayInDarwin();
const DAY = (n: number) => addDaysIso(TODAY, n);
const SYSTEM = { kind: "system", name: "tenancyReviewScheduleTimer" } as const;
const ANN = { kind: "user", name: "Ann", role: "accounts", userId: 7 } as const;

const facts = (over: Partial<OpenReviewFacts> = {}): OpenReviewFacts => ({
  calc: null,
  preparedById: null,
  reviewId: "rev-1",
  scheduledFor: DAY(5),
  state: "due",
  submittedAt: null,
  tenancyClosed: false,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  engine.raise.mockResolvedValue({ created: true, escalation: { escalationId: 1 } });
  engine.concludeForSubject.mockResolvedValue([]);
});

describe("the conditions", () => {
  it(`E1 holds for a review not commenced from ${NOT_COMMENCED_LEAD_DAYS} days before its date`, () => {
    expect(reviewConditionActive(REVIEW_POLICIES.notCommenced, facts({ scheduledFor: DAY(14) }), TODAY)).toBe(true);
    expect(reviewConditionActive(REVIEW_POLICIES.notCommenced, facts({ scheduledFor: DAY(15) }), TODAY)).toBe(false);
    expect(reviewConditionActive(REVIEW_POLICIES.notCommenced, facts({ state: "in_progress" }), TODAY)).toBe(false);
  });

  it("E2 holds for an open review past its date", () => {
    expect(reviewConditionActive(REVIEW_POLICIES.overdue, facts({ scheduledFor: DAY(-1), state: "in_progress" }), TODAY)).toBe(true);
    expect(reviewConditionActive(REVIEW_POLICIES.overdue, facts({ scheduledFor: DAY(0) }), TODAY)).toBe(false);
    expect(reviewConditionActive(REVIEW_POLICIES.overdue, facts({ scheduledFor: DAY(-1), state: "approved" }), TODAY)).toBe(false);
  });

  it("E3 holds while it waits for approval", () => {
    expect(reviewConditionActive(REVIEW_POLICIES.approval, facts({ state: "awaiting_approval" }), TODAY)).toBe(true);
    expect(reviewConditionActive(REVIEW_POLICIES.approval, facts({ state: "in_progress" }), TODAY)).toBe(false);
  });

  it("none holds for a vacated or archived tenancy", () => {
    for (const policy of Object.values(REVIEW_POLICIES)) {
      expect(reviewConditionActive(policy, facts({ scheduledFor: DAY(-9), state: "awaiting_approval", tenancyClosed: true }), TODAY)).toBe(false);
    }
  });

  it("E3 ends with the review's decision", () => {
    expect(approvalOutcomeCode("awaiting_approval")).toBeNull();
    expect(approvalOutcomeCode("approved")).toBe("approved");
    expect(approvalOutcomeCode("completed")).toBe("approved");
    expect(approvalOutcomeCode("in_progress")).toBe("returned");
    expect(approvalOutcomeCode("waived")).toBe("waived");
    expect(approvalOutcomeCode("cancelled")).toBe("cancelled");
  });
});

describe("shouldRaise: the generator never raises again what a person closed", () => {
  const overdue = facts({ scheduledFor: DAY(-2), state: "in_progress" });
  const ended = (resolutionCode: string, createdAt = new Date("2026-01-01T00:00:00Z")) => ({ createdAt, live: false, resolutionCode });

  it("raises when the condition holds and there has never been one", () => {
    expect(shouldRaise(REVIEW_POLICIES.overdue, overdue, null, TODAY)).toBe(true);
  });

  it("not while one is live, nor when the condition doesn't hold", () => {
    expect(shouldRaise(REVIEW_POLICIES.overdue, overdue, { createdAt: new Date(), live: true, resolutionCode: null }, TODAY)).toBe(false);
    expect(shouldRaise(REVIEW_POLICIES.overdue, facts(), null, TODAY)).toBe(false);
  });

  it.each(["action_taken", "no_action_needed", "other", "withdrawn"])("not after a person ended one (%s)", (code) => {
    expect(shouldRaise(REVIEW_POLICIES.overdue, overdue, ended(code), TODAY)).toBe(false);
  });

  it.each(["condition_cleared", "approved", "returned", "waived"])("again after one ended because the review moved on (%s), as after a revert", (code) => {
    expect(shouldRaise(REVIEW_POLICIES.overdue, overdue, ended(code), TODAY)).toBe(true);
  });

  it("raises E3 for a new submission even if one from before was withdrawn", () => {
    const waiting = { ...facts({ state: "awaiting_approval" }), submittedAt: new Date("2026-03-01T00:00:00Z") };
    expect(shouldRaise(REVIEW_POLICIES.approval, waiting, ended("withdrawn", new Date("2026-02-01T00:00:00Z")), TODAY)).toBe(true);
    expect(shouldRaise(REVIEW_POLICIES.approval, waiting, ended("withdrawn", new Date("2026-03-02T00:00:00Z")), TODAY)).toBe(false);
  });
});

describe("separationOfDuties", () => {
  it("is the preparer, and whoever keyed a manual rent", () => {
    const manual = { computedBy: { name: "Bo", userId: 9 }, manual: { explanation: "x", newAnnual: 1 } };
    expect(separationOfDuties({ calc: manual as never, preparedById: 7 })).toEqual([7, 9]);
    expect(separationOfDuties({ calc: { computedBy: { name: "Bo", userId: 9 } } as never, preparedById: 7 })).toEqual([7]);
    expect(separationOfDuties({ calc: null, preparedById: null })).toEqual([]);
  });
});

describe("approvalHeadline", () => {
  it("shows the change and why it needs someone else", () => {
    expect(approvalHeadline({ appliedPercent: 6.25, currentAnnual: 120000, newAnnual: 127500, reasons: ["override", "out_of_band"] })).toBe(
      "Waiting for approval: $120,000.00 → $127,500.00 (+6.25%) — a different rent was chosen; outside the usual range",
    );
  });
});

describe("planReviewEscalations", () => {
  it("raises E1 for an unstarted review near its date, E1 and E2 for an unstarted overdue one, and E3 for one left waiting", () => {
    const actions = planReviewEscalations(
      [
        facts({ reviewId: "near" }),
        facts({ reviewId: "late", scheduledFor: DAY(-3) }),
        facts({ reviewId: "waiting", state: "awaiting_approval" }),
        facts({ reviewId: "far", scheduledFor: DAY(40) }),
      ],
      new Map(),
      [],
      TODAY,
    );
    expect(actions.map((a) => (a.kind === "raise" ? `${a.review.reviewId}:${a.policyKey}` : a))).toEqual([
      "near:rent_review.not_commenced",
      "late:rent_review.not_commenced",
      "late:rent_review.overdue",
      "waiting:rent_review.approval",
    ]);
  });

  it("leaves a review alone when its escalation is live, and ends an E3 whose review has moved on", () => {
    const history = new Map([[historyKey("near", REVIEW_POLICIES.notCommenced), { createdAt: new Date(), live: true, resolutionCode: null }]]);
    const actions = planReviewEscalations([facts({ reviewId: "near" })], history, [{ reviewId: "gone", scheduledFor: DAY(-1), state: "approved" }], TODAY);
    expect(actions).toEqual([{ code: "approved", kind: "end", reviewId: "gone", scheduledFor: DAY(-1), state: "approved" }]);
  });
});

describe("raiseApprovalEscalation (E3, after SUBMIT)", () => {
  const input = { actor: ANN, appliedPercent: 6, currentAnnual: 100000, excludeUserIds: [7], newAnnual: 106000, reasons: ["out_of_band"], reviewId: "rev-1" };

  it("raises rent_review.approval on the review, away from the preparer", async () => {
    await raiseApprovalEscalation(conn, input);
    expect(engine.raise).toHaveBeenCalledWith(conn, expect.objectContaining({
      actor: ANN,
      excludeUserIds: [7],
      policyKey: "rent_review.approval",
      subjectId: "rev-1",
      subjectType: "rent_review",
    }));
  });

  it("goes on without it when the policy is switched off, and reports a real failure", async () => {
    engine.raise.mockRejectedValueOnce(new EscalationError("policy_inactive", "off"));
    await expect(raiseApprovalEscalation(conn, input)).resolves.toBeNull();
    expect(Sentry.captureException).not.toHaveBeenCalled();
    engine.raise.mockRejectedValueOnce(new Error("database down"));
    await expect(raiseApprovalEscalation(conn, input)).resolves.toBeNull();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });
});

describe("settleReviewEscalations (after a decision commits)", () => {
  const settle = (state: OpenReviewFacts["state"], code: string, scheduledFor = DAY(-5), note: string | null = null) =>
    settleReviewEscalations(conn, { actor: ANN, code, note, reviewId: "rev-1", scheduledFor, state, today: TODAY });

  it("ends E1 when the review is commenced, and leaves an overdue E2 running", async () => {
    await settle("in_progress", "commenced");
    expect(engine.concludeForSubject.mock.calls[0][1]).toMatchObject({
      code: "commenced",
      policyKeys: ["rent_review.approval", "rent_review.not_commenced"],
      subjectId: "rev-1",
      subjectType: "rent_review",
      withdrawOpen: false,
    });
  });

  it("ends everything on the review when it is approved", async () => {
    await settle("approved", "approved");
    expect(engine.concludeForSubject.mock.calls[0][1].policyKeys.sort()).toEqual(
      ["any.manual", "rent_review.approval", "rent_review.not_commenced", "rent_review.overdue"].sort(),
    );
  });

  it("withdraws, with the cancel's reason, when the review is cancelled", async () => {
    await settle("cancelled", "cancelled", DAY(-5), "Tenant vacated");
    expect(engine.concludeForSubject.mock.calls[0][1]).toMatchObject({ code: "cancelled", note: "Tenant vacated", withdrawOpen: true });
  });

  it("never throws: a failure is reported and the decision stands", async () => {
    engine.concludeForSubject.mockRejectedValueOnce(new Error("nope"));
    await expect(settle("approved", "approved")).resolves.toBe(0);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });
});

describe("runReviewEscalations (the generator's step)", () => {
  const openRow = (over: Record<string, unknown> = {}) => ({
    Calc: null,
    PreparedById: null,
    ReviewId: "rev-1",
    ScheduledFor: new Date(`${DAY(-3)}T00:00:00Z`),
    State: "due",
    SubmittedAt: null,
    TenantArchivedAt: null,
    TenantStatus: "current",
    ...over,
  });

  function serve(open: unknown[], history: unknown[] = [], stranded: unknown[] = []) {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (sql.includes("FROM dbo.Escalations e\n  LEFT JOIN")) return stranded;
      if (sql.includes("FROM dbo.Escalations e")) return history;
      if (sql.includes("FROM dbo.RentReviews r")) return open;
      throw new Error(`unexpected SQL: ${sql}`);
    });
  }
  const runStep = (over: Partial<Parameters<typeof runReviewEscalations>[1]> = {}) =>
    runReviewEscalations(conn, { actor: SYSTEM, dryRun: false, log: jest.fn(), today: TODAY, warn: jest.fn(), ...over });

  it("raises E1 and E2 for an unstarted overdue review, as the generator", async () => {
    serve([openRow()]);
    const result = await runStep();
    expect(result).toEqual({ ended: 0, errors: [], raised: 2, truncated: false });
    expect(engine.raise.mock.calls.map(([, input]) => [input.policyKey, input.actor, input.skipConditionCheck, input.subjectType])).toEqual([
      ["rent_review.not_commenced", SYSTEM, true, "rent_review"],
      ["rent_review.overdue", SYSTEM, true, "rent_review"],
    ]);
    expect(engine.raise.mock.calls[1][1].headline).toMatch(/^Overdue: the review was due \d{2}\/\d{2}\/\d{4}$/);
  });

  it("writes nothing in a dry run, and counts what it would do", async () => {
    serve([openRow()], [], [{ ScheduledFor: null, State: "approved", SubjectId: "rev-9" }]);
    const log = jest.fn();
    const result = await runStep({ dryRun: true, log });
    expect(result).toEqual({ ended: 1, errors: [], raised: 2, truncated: false });
    expect(engine.raise).not.toHaveBeenCalled();
    expect(engine.concludeForSubject).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("dry run, nothing written"));
  });

  it("raises a missing E3 away from the preparer, and ends an E3 left behind by a decision", async () => {
    serve(
      [openRow({ PreparedById: 7, ScheduledFor: new Date(`${DAY(20)}T00:00:00Z`), State: "awaiting_approval", SubmittedAt: new Date() })],
      [],
      [{ ScheduledFor: new Date(`${DAY(-1)}T00:00:00Z`), State: "in_progress", SubjectId: "rev-2" }],
    );
    const result = await runStep();
    expect(result).toMatchObject({ errors: [], raised: 1 });
    expect(engine.raise.mock.calls[0][1]).toMatchObject({ excludeUserIds: [7], policyKey: "rent_review.approval" });
    expect(engine.concludeForSubject.mock.calls[0][1]).toMatchObject({ code: "returned", policyKeys: ["rent_review.approval"], subjectId: "rev-2" });
  });

  it("re-raises E3 with the override's own % beside the override's rent, and why it waits (L8)", async () => {
    const calc = {
      appliedPercent: 3.2,
      cascade: [],
      currentAnnual: 123711.34,
      method: "cpi",
      newAnnual: 127670.1,
      override: { differenceAnnual: -2114.55, newAnnual: 125555.55, reason: "Negotiated" },
      sanity: { inBand: true, maxPercent: 15, minPercent: -5 },
      scheduleVersion: 4,
    };
    serve([openRow({ Calc: JSON.stringify(calc), PreparedById: 7, ScheduledFor: new Date(`${DAY(20)}T00:00:00Z`), State: "awaiting_approval", SubmittedAt: new Date() })]);
    await runStep();
    expect(engine.raise.mock.calls[0][1].headline).toBe("Waiting for approval: $123,711.34 → $125,555.55 (+1.49%) — a different rent was chosen");
  });

  it("skips a policy that is switched off without counting it a failure, and collects real failures", async () => {
    serve([openRow()]);
    engine.raise.mockRejectedValueOnce(new EscalationError("policy_inactive", "off")).mockRejectedValueOnce(new Error("boom"));
    const result = await runStep();
    expect(result.errors).toEqual([{ message: "boom", reviewId: "rev-1" }]);
  });

  it("stops at ESCALATION_SWEEP_MAX_ACTIONS and says the rest waits", async () => {
    serve([openRow({ ReviewId: "a" }), openRow({ ReviewId: "b" })]);
    const result = await runStep({ env: { ESCALATION_SWEEP_MAX_ACTIONS: "3" } });
    expect(result).toMatchObject({ raised: 3, truncated: true });
  });

  it("leaves a vacated tenancy's review alone", async () => {
    serve([openRow({ TenantStatus: "vacated" })]);
    expect(await runStep()).toMatchObject({ raised: 0 });
  });
});
