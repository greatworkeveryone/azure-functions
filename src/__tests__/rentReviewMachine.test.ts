/// <reference types="jest" />
// The rent review machine (PLAN §3.1). This file is identical in both repos
// apart from the import line below (the frontend copy imports
// "@/types/rentReviewMachine"): change one, change the other.
//
// SPEC restates the PLAN's table independently of the implementation, so a
// transition added to or dropped from the machine fails here until the spec
// is edited on purpose.
import {
  canTransition,
  isOpenState,
  isOverdue,
  nextState,
  OPEN_RENT_REVIEW_STATES,
  RENT_REVIEW_EVENTS,
  RENT_REVIEW_STATES,
  type RentReviewEvent,
  type RentReviewFacts,
  type RentReviewState,
} from "../rentReviewMachine";

type From = RentReviewState | null;

const OPEN: RentReviewState[] = ["scheduled", "due", "in_progress", "awaiting_index", "referred", "awaiting_approval"];

// event -> [from states, target when its facts are satisfied]
const SPEC: Record<RentReviewEvent, { from: From[]; to: RentReviewState }> = {
  SCHEDULE: { from: [null], to: "scheduled" },
  OPEN_WINDOW: { from: ["scheduled"], to: "due" },
  COMMENCE: { from: ["scheduled", "due"], to: "in_progress" },
  INDEX_PENDING: { from: ["in_progress"], to: "awaiting_index" },
  INDEX_AVAILABLE: { from: ["awaiting_index"], to: "in_progress" },
  REFER: { from: ["in_progress"], to: "referred" },
  RECORD_MILESTONE: { from: ["referred"], to: "referred" },
  // The director path lands on approved; everyone else's lands on awaiting_approval.
  RECORD_OUTCOME: { from: ["referred"], to: "approved" },
  SUBMIT: { from: ["in_progress"], to: "approved" },
  APPROVE: { from: ["awaiting_approval"], to: "approved" },
  RETURN: { from: ["awaiting_approval"], to: "in_progress" },
  WAIVE: { from: OPEN, to: "waived" },
  CANCEL: { from: OPEN, to: "cancelled" },
  ISSUE_NOTICE: { from: ["approved"], to: "approved" },
  CONFIRM_BILLING: { from: ["approved"], to: "approved" },
  CLOSE: { from: ["approved"], to: "completed" },
  REVERT: { from: ["approved"], to: "in_progress" },
};

/** Facts that satisfy every guard and take the "applies now" branch. */
function satisfied(event: RentReviewEvent): RentReviewFacts {
  return {
    autoApprove: true,
    billingConfirmed: true,
    method: event === "REFER" ? "market" : "cpi",
    noticeHandled: true,
    recordedByDirector: true,
    withinWindow: true,
  };
}

const STATES_AND_NONE: From[] = [null, ...RENT_REVIEW_STATES];
const PAIRS: Array<[From, RentReviewEvent]> = STATES_AND_NONE.flatMap((state) =>
  RENT_REVIEW_EVENTS.map((event): [From, RentReviewEvent] => [state, event]),
);

describe("the vocabulary", () => {
  it("has the ten states and seventeen events of PLAN §3.1, each once", () => {
    expect([...RENT_REVIEW_STATES].sort()).toEqual(
      [
        "approved",
        "awaiting_approval",
        "awaiting_index",
        "cancelled",
        "completed",
        "due",
        "in_progress",
        "referred",
        "scheduled",
        "waived",
      ].sort(),
    );
    expect(new Set(RENT_REVIEW_STATES).size).toBe(10);
    expect(new Set(RENT_REVIEW_EVENTS).size).toBe(17);
    expect(Object.keys(SPEC).sort()).toEqual([...RENT_REVIEW_EVENTS].sort());
  });
});

describe("every state x event pair", () => {
  it("covers 11 starting points (ten states and 'no instance') x 17 events", () => {
    expect(PAIRS).toHaveLength(11 * 17);
  });

  it.each(PAIRS)("%s + %s is allowed with the right target, or refused", (state, event) => {
    const rule = SPEC[event];
    const legal = rule.from.includes(state);
    const target = nextState(state, event, satisfied(event));
    if (!legal) {
      expect(target).toBeNull();
      expect(canTransition(state, event, satisfied(event))).toBe(false);
      return;
    }
    expect(canTransition(state, event, satisfied(event))).toBe(true);
    expect(target).toBe(rule.to);
  });

  it("allows exactly the transitions in the spec, no more", () => {
    const legalPairs = PAIRS.filter(([state, event]) => canTransition(state, event, satisfied(event)));
    const specPairs = Object.entries(SPEC).flatMap(([event, rule]) =>
      rule.from.map((state): [From, RentReviewEvent] => [state, event as RentReviewEvent]),
    );
    expect(legalPairs).toHaveLength(specPairs.length);
    // 28 legal pairs: WAIVE and CANCEL from six states each, COMMENCE from two, the other fourteen events from one.
    expect(legalPairs).toHaveLength(28);
  });

  it("never lets a finished review (completed, waived, cancelled) move again", () => {
    for (const state of ["completed", "waived", "cancelled"] as const) {
      for (const event of RENT_REVIEW_EVENTS) {
        expect(nextState(state, event, satisfied(event))).toBeNull();
      }
    }
  });

  it("creates an instance only with SCHEDULE, and only from nothing", () => {
    expect(nextState(null, "SCHEDULE")).toBe("scheduled");
    for (const state of RENT_REVIEW_STATES) expect(nextState(state, "SCHEDULE")).toBeNull();
    for (const event of RENT_REVIEW_EVENTS.filter((e) => e !== "SCHEDULE")) {
      expect(nextState(null, event, satisfied(event))).toBeNull();
    }
  });

  it("refuses an event name it does not know instead of throwing", () => {
    expect(nextState("scheduled", "constructor" as RentReviewEvent)).toBeNull();
    expect(nextState("scheduled", "toString" as RentReviewEvent)).toBeNull();
    expect(nextState("scheduled", "NOT_AN_EVENT" as RentReviewEvent)).toBeNull();
  });
});

describe("guards read facts strictly", () => {
  it("OPEN_WINDOW needs withinWindow", () => {
    expect(nextState("scheduled", "OPEN_WINDOW")).toBeNull();
    expect(nextState("scheduled", "OPEN_WINDOW", {})).toBeNull();
    expect(nextState("scheduled", "OPEN_WINDOW", { withinWindow: false })).toBeNull();
    expect(nextState("scheduled", "OPEN_WINDOW", { withinWindow: true })).toBe("due");
  });

  it("INDEX_PENDING is for CPI reviews only", () => {
    expect(nextState("in_progress", "INDEX_PENDING")).toBeNull();
    for (const method of ["fixed", "market", "other"] as const) {
      expect(nextState("in_progress", "INDEX_PENDING", { method })).toBeNull();
    }
    expect(nextState("in_progress", "INDEX_PENDING", { method: "cpi" })).toBe("awaiting_index");
  });

  it("REFER is for market reviews only", () => {
    expect(nextState("in_progress", "REFER")).toBeNull();
    for (const method of ["cpi", "fixed", "other"] as const) {
      expect(nextState("in_progress", "REFER", { method })).toBeNull();
    }
    expect(nextState("in_progress", "REFER", { method: "market" })).toBe("referred");
  });

  it("CLOSE needs the notice handled and billing confirmed, both", () => {
    expect(nextState("approved", "CLOSE")).toBeNull();
    expect(nextState("approved", "CLOSE", { noticeHandled: true })).toBeNull();
    expect(nextState("approved", "CLOSE", { billingConfirmed: true })).toBeNull();
    expect(nextState("approved", "CLOSE", { billingConfirmed: false, noticeHandled: true })).toBeNull();
    expect(nextState("approved", "CLOSE", { billingConfirmed: true, noticeHandled: true })).toBe("completed");
  });

  it("a fact that is merely truthy does not count", () => {
    const sloppy = { withinWindow: "yes" } as unknown as RentReviewFacts;
    expect(nextState("scheduled", "OPEN_WINDOW", sloppy)).toBeNull();
  });
});

describe("facts that choose the target default to the safe branch", () => {
  it("SUBMIT applies only when the result is in bounds with no override", () => {
    expect(nextState("in_progress", "SUBMIT")).toBe("awaiting_approval");
    expect(nextState("in_progress", "SUBMIT", { autoApprove: false })).toBe("awaiting_approval");
    expect(nextState("in_progress", "SUBMIT", { autoApprove: true })).toBe("approved");
  });

  it("RECORD_OUTCOME applies at once only when a director records it", () => {
    expect(nextState("referred", "RECORD_OUTCOME")).toBe("awaiting_approval");
    expect(nextState("referred", "RECORD_OUTCOME", { recordedByDirector: false })).toBe("awaiting_approval");
    expect(nextState("referred", "RECORD_OUTCOME", { recordedByDirector: true })).toBe("approved");
  });
});

describe("open and overdue", () => {
  it("open is the six states before approval", () => {
    expect([...OPEN_RENT_REVIEW_STATES].sort()).toEqual([...OPEN].sort());
    for (const state of RENT_REVIEW_STATES) expect(isOpenState(state)).toBe(OPEN.includes(state));
  });

  it("is overdue only while open and only once the date has passed (Darwin date, text comparison)", () => {
    expect(isOverdue("scheduled", "2026-07-01", "2026-07-02")).toBe(true);
    expect(isOverdue("due", "2026-07-01", "2026-07-02")).toBe(true);
    expect(isOverdue("in_progress", "2026-07-01", "2026-07-02")).toBe(true);
    expect(isOverdue("awaiting_index", "2026-07-01", "2026-07-02")).toBe(true);
    expect(isOverdue("referred", "2026-07-01", "2026-07-02")).toBe(true);
    expect(isOverdue("awaiting_approval", "2026-07-01", "2026-07-02")).toBe(true);
  });

  it("is not overdue on the day itself or before it", () => {
    expect(isOverdue("due", "2026-07-01", "2026-07-01")).toBe(false);
    expect(isOverdue("due", "2026-07-01", "2026-06-30")).toBe(false);
    expect(isOverdue("scheduled", "2027-01-01", "2026-07-01")).toBe(false);
  });

  it("is never overdue once approved, completed, waived or cancelled", () => {
    for (const state of ["approved", "completed", "waived", "cancelled"] as const) {
      expect(isOverdue(state, "2020-01-01", "2026-07-01")).toBe(false);
    }
  });

  it("compares month and day, not just the year", () => {
    expect(isOverdue("due", "2026-12-31", "2027-01-01")).toBe(true);
    expect(isOverdue("due", "2026-09-30", "2026-10-01")).toBe(true);
    expect(isOverdue("due", "2026-10-01", "2026-09-30")).toBe(false);
  });
});

describe("whole journeys", () => {
  function walk(steps: Array<[RentReviewEvent, RentReviewFacts?]>): RentReviewState | null {
    let state: RentReviewState | null = null;
    for (const [event, facts] of steps) {
      const next = nextState(state, event, facts);
      if (next === null) throw new Error(`${state} + ${event} refused`);
      state = next;
    }
    return state;
  }

  it("a fixed review that applies on submit, then closes out", () => {
    expect(
      walk([
        ["SCHEDULE"],
        ["OPEN_WINDOW", { withinWindow: true }],
        ["COMMENCE"],
        ["SUBMIT", { autoApprove: true }],
        ["ISSUE_NOTICE"],
        ["CONFIRM_BILLING"],
        ["CLOSE", { billingConfirmed: true, noticeHandled: true }],
      ]),
    ).toBe("completed");
  });

  it("a CPI review that waits for the index, is returned once, then approved", () => {
    expect(
      walk([
        ["SCHEDULE"],
        ["COMMENCE"],
        ["INDEX_PENDING", { method: "cpi" }],
        ["INDEX_AVAILABLE"],
        ["SUBMIT"],
        ["RETURN"],
        ["SUBMIT"],
        ["APPROVE"],
      ]),
    ).toBe("approved");
  });

  it("a market review referred to the directors, decided by a non-director, then approved", () => {
    expect(
      walk([
        ["SCHEDULE"],
        ["COMMENCE"],
        ["REFER", { method: "market" }],
        ["RECORD_MILESTONE"],
        ["RECORD_OUTCOME"],
        ["APPROVE"],
      ]),
    ).toBe("approved");
  });

  it("an approved review can be reverted to in_progress and applied again", () => {
    expect(walk([["SCHEDULE"], ["COMMENCE"], ["SUBMIT", { autoApprove: true }], ["REVERT"], ["SUBMIT"], ["APPROVE"]])).toBe(
      "approved",
    );
  });

  it("waiving or cancelling is possible from every open state and nowhere else", () => {
    for (const event of ["WAIVE", "CANCEL"] as const) {
      for (const state of RENT_REVIEW_STATES) {
        expect(canTransition(state, event)).toBe(isOpenState(state));
      }
    }
  });
});
