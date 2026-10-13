import assert from "node:assert";
import { computeReviewState } from "../functions/tenancy";
import {
  deriveNextReviewDate,
  type NextReviewInput,
  nextReviewInputFromRow,
  parseResolvedReviewDates,
  reviewWorkflowLiveFrom,
  sqlDateToIso,
} from "../nextReviewDate";
import type { ScheduledRateStep } from "../scheduledRateStepLogic";

const comm = (effectiveFrom: string): ScheduledRateStep => ({
  baseRentPerAnnum: 100000,
  effectiveFrom,
  id: `c-${effectiveFrom}`,
  methodKind: "commencement",
  ratePercent: 0,
});
const fixed = (effectiveFrom: string, extra: Partial<ScheduledRateStep> = {}): ScheduledRateStep => ({
  effectiveFrom,
  id: `f-${effectiveFrom}`,
  methodKind: "fixed",
  ratePercent: 3,
  ...extra,
});
const cpiPending = (effectiveFrom: string, extra: Partial<ScheduledRateStep> = {}): ScheduledRateStep => ({
  effectiveFrom,
  id: `p-${effectiveFrom}`,
  methodKind: "cpi",
  ratePercent: 0,
  ...extra,
});

/** Gate B, in the "set" examples. */
const LIVE_FROM = "2026-11-01";
const TODAY = "2026-11-15";

function input(over: Partial<NextReviewInput>): NextReviewInput {
  return {
    commencement: null,
    lastReviewDate: null,
    resolvedReviewDates: new Set(),
    reviewIntervalMonths: 12,
    steps: [],
    storedNextReviewDate: null,
    today: TODAY,
    workflowLiveFrom: null,
    ...over,
  };
}

describe("REVIEW_WORKFLOW_LIVE_FROM", () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    delete process.env.REVIEW_WORKFLOW_LIVE_FROM;
  });

  it("is unset when missing or blank", () => {
    assert.strictEqual(reviewWorkflowLiveFrom(undefined), null);
    assert.strictEqual(reviewWorkflowLiveFrom("  "), null);
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads a YYYY-MM-DD date", () => {
    assert.strictEqual(reviewWorkflowLiveFrom(" 2026-11-01 "), "2026-11-01");
  });

  it("logs a warning for an invalid value and treats it as unset", () => {
    assert.strictEqual(reviewWorkflowLiveFrom("2026-13-01"), null);
    assert.strictEqual(reviewWorkflowLiveFrom("1/11/2026"), null);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"2026-13-01" is not a YYYY-MM-DD date'));
  });

  it("is what nextReviewInputFromRow derives with", () => {
    process.env.REVIEW_WORKFLOW_LIVE_FROM = LIVE_FROM;
    assert.strictEqual(nextReviewInputFromRow({}, []).workflowLiveFrom, LIVE_FROM);
    process.env.REVIEW_WORKFLOW_LIVE_FROM = "soon";
    assert.strictEqual(nextReviewInputFromRow({}, []).workflowLiveFrom, null);
  });
});

describe("deriveNextReviewDate — unset: reviews keyed by hand", () => {
  // A lease with five 3% steps keyed in at signing.
  const fiveYearFixed = [
    comm("2024-07-01"),
    fixed("2025-07-01"),
    fixed("2026-07-01"),
    fixed("2027-07-01"),
    fixed("2028-07-01"),
    fixed("2029-07-01"),
  ];

  it.each([
    ["2025-06-30", "2025-07-01"],
    ["2025-07-01", "2026-07-01"],
    ["2026-06-30", "2026-07-01"],
    ["2026-07-01", "2027-07-01"],
    ["2027-07-01", "2028-07-01"],
    ["2028-07-01", "2029-07-01"],
    ["2029-07-01", "2030-07-01"],
  ])("a pre-filled fixed schedule walks step by step: on %s the next review is %s", (today, next) => {
    assert.strictEqual(deriveNextReviewDate(input({ commencement: "2024-07-01", steps: fiveYearFixed, today })), next);
  });

  it("settles a keyed row once its date has come — it never reads overdue", () => {
    const steps = [comm("2020-07-01"), fixed("2026-07-01")];
    const next = deriveNextReviewDate(input({ commencement: "2020-07-01", steps }));
    assert.strictEqual(next, "2027-07-01");
    assert.strictEqual(computeReviewState(next ?? undefined, "current", TODAY), "green");
  });

  it("keeps a row keyed ahead of its date as the upcoming review", () => {
    const steps = [comm("2020-07-01"), fixed("2026-07-01"), fixed("2027-07-01")];
    assert.strictEqual(deriveNextReviewDate(input({ commencement: "2020-07-01", steps })), "2027-07-01");
    assert.strictEqual(
      deriveNextReviewDate(input({ commencement: "2020-07-01", steps, today: "2026-06-30" })),
      "2026-07-01",
    );
  });

  it("is the earliest review still waiting on its value", () => {
    const steps = [comm("2020-07-01"), fixed("2024-07-01"), cpiPending("2025-07-01"), fixed("2026-07-01")];
    assert.strictEqual(deriveNextReviewDate(input({ commencement: "2020-07-01", steps })), "2025-07-01");
  });
});

describe("deriveNextReviewDate — set: the review workflow is live", () => {
  const live = (over: Partial<NextReviewInput>) => input({ workflowLiveFrom: LIVE_FROM, ...over });

  it("from the live date only a settlement counts; a known value no longer does", () => {
    const steps = [comm("2020-07-01"), fixed("2025-07-01"), fixed("2027-07-01"), fixed("2028-07-01")];
    assert.strictEqual(deriveNextReviewDate(live({ commencement: "2020-07-01", steps })), "2027-07-01");
  });

  it("splits at the live date: the day before settles by its value, the day itself doesn't", () => {
    const before = [comm("2020-10-31"), fixed("2026-10-31")];
    assert.strictEqual(deriveNextReviewDate(live({ steps: before })), "2027-10-31");
    const onTheDay = [comm("2020-11-01"), fixed("2026-11-01")];
    assert.strictEqual(deriveNextReviewDate(live({ steps: onTheDay })), "2026-11-01");
  });

  it("is settled by an applied or waived resolution", () => {
    const steps = [
      comm("2020-07-01"),
      fixed("2027-07-01", { resolution: "applied" }),
      cpiPending("2028-07-01", { resolution: "waived" }),
      fixed("2029-07-01"),
    ];
    assert.strictEqual(deriveNextReviewDate(live({ commencement: "2020-07-01", steps })), "2029-07-01");
  });

  it("is settled by a completed or waived RentReviews row for its date", () => {
    const steps = [comm("2020-07-01"), fixed("2027-07-01"), fixed("2028-07-01")];
    const derived = deriveNextReviewDate(
      live({ commencement: "2020-07-01", resolvedReviewDates: new Set(["2027-07-01"]), steps }),
    );
    assert.strictEqual(derived, "2028-07-01");
  });

  it("only looks after LastReviewDate", () => {
    const steps = [comm("2020-07-01"), fixed("2027-07-01"), fixed("2028-07-01")];
    const derived = deriveNextReviewDate(live({ commencement: "2020-07-01", lastReviewDate: "2027-07-01", steps }));
    assert.strictEqual(derived, "2028-07-01");
  });
});

describe("an unkeyed review past its date reads overdue in both modes", () => {
  it.each([
    ["unset", null],
    ["set", LIVE_FROM],
  ])("%s", (_mode, workflowLiveFrom) => {
    const steps = [comm("2020-07-01"), fixed("2025-07-01"), cpiPending("2026-07-01"), fixed("2027-07-01")];
    const next = deriveNextReviewDate(input({ commencement: "2020-07-01", steps, workflowLiveFrom }));
    assert.strictEqual(next, "2026-07-01");
    assert.strictEqual(computeReviewState(next ?? undefined, "current", TODAY), "red");
  });
});

describe("deriveNextReviewDate — anniversaries", () => {
  it("is the anniversary after the last settled review when no review row is open", () => {
    const steps = [comm("2020-07-01"), fixed("2027-07-01", { resolution: "applied" })];
    assert.strictEqual(deriveNextReviewDate(input({ commencement: "2020-07-01", steps })), "2028-07-01");
  });

  it("stays on the anniversary when a review was processed late", () => {
    const steps = [comm("2020-07-01"), fixed("2027-07-01", { resolution: "applied" })];
    // LastReviewDate recorded as the day it was processed, six weeks late.
    const derived = deriveNextReviewDate(input({ commencement: "2020-07-01", lastReviewDate: "2027-08-15", steps }));
    assert.strictEqual(derived, "2028-07-01");
  });

  it("follows a schedule's gaps: a commencement row alone means the first anniversary is due", () => {
    assert.strictEqual(
      deriveNextReviewDate(input({ commencement: "2020-07-01", steps: [comm("2020-07-01")] })),
      "2021-07-01",
    );
  });

  it("clamps to month end and counts every anniversary from commencement", () => {
    const steps = [comm("2020-01-31"), fixed("2027-01-31", { resolution: "applied" })];
    const monthly = deriveNextReviewDate(input({ commencement: "2020-01-31", reviewIntervalMonths: 1, steps }));
    assert.strictEqual(monthly, "2027-02-28");
    const leap = [comm("2020-02-29"), fixed("2027-02-28", { resolution: "applied" })];
    assert.strictEqual(deriveNextReviewDate(input({ commencement: "2020-02-29", steps: leap })), "2028-02-29");
  });

  it("uses ReviewIntervalMonths, defaulting to 12", () => {
    const steps = [comm("2020-07-01"), fixed("2026-07-01")];
    assert.strictEqual(
      deriveNextReviewDate(input({ commencement: "2020-07-01", reviewIntervalMonths: 24, steps })),
      "2028-07-01",
    );
    assert.strictEqual(
      deriveNextReviewDate(input({ commencement: "2020-07-01", reviewIntervalMonths: null, steps })),
      "2027-07-01",
    );
    assert.strictEqual(
      deriveNextReviewDate(input({ commencement: "2020-07-01", reviewIntervalMonths: 0, steps })),
      "2027-07-01",
    );
  });

  it("restarts the anniversaries from a later commencement row (renewal or rent reset)", () => {
    const steps = [comm("2015-07-01"), fixed("2016-07-01"), comm("2024-03-15")];
    assert.strictEqual(deriveNextReviewDate(input({ commencement: "2015-07-01", steps })), "2025-03-15");
  });

  it("anchors on the commencement row, then the first row, when Commencement is blank", () => {
    assert.strictEqual(
      deriveNextReviewDate(input({ steps: [comm("2021-03-01"), fixed("2026-03-01")] })),
      "2027-03-01",
    );
    assert.strictEqual(deriveNextReviewDate(input({ steps: [fixed("2025-09-01"), fixed("2026-09-01")] })), "2027-09-01");
  });
});

describe("deriveNextReviewDate — tenancies without a schedule", () => {
  it("keeps a stored date: it is the only record of where reviews stand", () => {
    const derived = deriveNextReviewDate(
      input({ commencement: "2018-03-01", storedNextReviewDate: "2019-03-01" }),
    );
    assert.strictEqual(derived, null);
  });

  it("gives a tenancy with no date its first anniversary after commencement or the last review", () => {
    assert.strictEqual(deriveNextReviewDate(input({ commencement: "2026-12-01" })), "2027-12-01");
    assert.strictEqual(
      deriveNextReviewDate(input({ commencement: "2018-03-01", lastReviewDate: "2026-03-01" })),
      "2027-03-01",
    );
  });

  it("has nothing to go on without a commencement date", () => {
    assert.strictEqual(deriveNextReviewDate(input({})), null);
  });
});

describe("row helpers", () => {
  it("parses the resolved review dates list", () => {
    assert.deepStrictEqual(
      [...parseResolvedReviewDates("2025-07-01,2026-07-01, 2027-07-01,junk")],
      ["2025-07-01", "2026-07-01", "2027-07-01"],
    );
    assert.strictEqual(parseResolvedReviewDates(null).size, 0);
    assert.strictEqual(parseResolvedReviewDates("").size, 0);
  });

  it("reads SQL dates", () => {
    assert.strictEqual(sqlDateToIso(new Date("2026-07-01T00:00:00Z")), "2026-07-01");
    assert.strictEqual(sqlDateToIso("2026-07-01T00:00:00.000Z"), "2026-07-01");
    assert.strictEqual(sqlDateToIso("2026-02-30"), null);
    assert.strictEqual(sqlDateToIso(new Date("nope")), null);
    assert.strictEqual(sqlDateToIso(null), null);
  });

  it("builds the input from a Tenants row", () => {
    const steps = [comm("2020-07-01")];
    const built = nextReviewInputFromRow(
      {
        Commencement: new Date("2020-07-01T00:00:00Z"),
        LastReviewDate: null,
        NextReviewDate: "2021-07-01",
        ResolvedReviewDates: "2021-07-01",
        ReviewIntervalMonths: 12,
      },
      steps,
      TODAY,
    );
    assert.deepStrictEqual(built, {
      commencement: "2020-07-01",
      lastReviewDate: null,
      resolvedReviewDates: new Set(["2021-07-01"]),
      reviewIntervalMonths: 12,
      steps,
      storedNextReviewDate: "2021-07-01",
      today: TODAY,
      workflowLiveFrom: null,
    });
    assert.strictEqual(nextReviewInputFromRow({ ReviewIntervalMonths: null }, []).reviewIntervalMonths, null);
  });
});
