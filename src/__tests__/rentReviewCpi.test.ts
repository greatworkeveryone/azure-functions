/// <reference types="jest" />
// The CPI suggestion on a CPI review: the reference quarter is the quarter
// ending immediately before the review date (PLAN Q5), the earlier value is one
// review interval before it, and the two come from one base or not at all.
import {
  buildCpiSuggestion,
  CPI_RELEASE_LAG_DAYS,
  expectedRelease,
  previousQuarter,
  quarterEnd,
  quarterOf,
  referenceQuarter,
  shiftQuarters,
  type CpiIndexRow,
} from "../rentReview/cpi";

describe("quarters", () => {
  it("finds the quarter a date falls in", () => {
    expect(quarterOf("2026-01-01")).toBe("2026-Q1");
    expect(quarterOf("2026-03-31")).toBe("2026-Q1");
    expect(quarterOf("2026-04-01")).toBe("2026-Q2");
    expect(quarterOf("2026-09-30")).toBe("2026-Q3");
    expect(quarterOf("2026-12-31")).toBe("2026-Q4");
  });

  it("knows the last day of each quarter, leap years included", () => {
    expect(quarterEnd("2026-Q1")).toBe("2026-03-31");
    expect(quarterEnd("2026-Q2")).toBe("2026-06-30");
    expect(quarterEnd("2026-Q3")).toBe("2026-09-30");
    expect(quarterEnd("2028-Q4")).toBe("2028-12-31");
  });

  it("shifts across year ends in both directions", () => {
    expect(shiftQuarters("2026-Q1", -1)).toBe("2025-Q4");
    expect(shiftQuarters("2026-Q2", -4)).toBe("2025-Q2");
    expect(shiftQuarters("2026-Q4", 1)).toBe("2027-Q1");
    expect(shiftQuarters("2026-Q3", -9)).toBe("2024-Q2");
    expect(shiftQuarters("2026-Q3", 0)).toBe("2026-Q3");
  });

  it("refuses something that isn't a quarter", () => {
    expect(() => shiftQuarters("2026-Q5", 1)).toThrow();
    expect(() => quarterEnd("June 2026")).toThrow();
  });
});

describe("referenceQuarter: the quarter ending immediately before the review date", () => {
  it.each([
    ["2026-07-01", "2026-Q2"], // the day after June ends
    ["2026-07-02", "2026-Q2"],
    ["2026-08-15", "2026-Q2"],
    ["2026-09-30", "2026-Q2"], // still inside Q3
    ["2026-10-01", "2026-Q3"],
    ["2026-06-30", "2026-Q1"], // June ends on the review date itself, so it has not ended before it
    ["2026-04-01", "2026-Q1"],
    ["2026-01-01", "2025-Q4"],
    ["2026-12-31", "2026-Q3"],
  ])("a review on %s is worked from %s", (reviewDate, expected) => {
    expect(referenceQuarter(reviewDate)).toBe(expected);
  });

  it("always ends strictly before the review date", () => {
    for (const reviewDate of ["2026-01-01", "2026-03-31", "2026-04-01", "2026-06-30", "2026-07-01", "2026-12-31"]) {
      expect(quarterEnd(referenceQuarter(reviewDate)) < reviewDate).toBe(true);
    }
  });
});

describe("previousQuarter: one review interval before the reference quarter", () => {
  it("is four quarters back for a yearly review, and defaults to yearly", () => {
    expect(previousQuarter("2026-Q2", 12)).toBe("2025-Q2");
    expect(previousQuarter("2026-Q2", null)).toBe("2025-Q2");
    expect(previousQuarter("2026-Q2", 0)).toBe("2025-Q2");
  });

  it("follows other intervals in whole quarters, at least one", () => {
    expect(previousQuarter("2026-Q2", 6)).toBe("2025-Q4");
    expect(previousQuarter("2026-Q2", 24)).toBe("2024-Q2");
    expect(previousQuarter("2026-Q2", 36)).toBe("2023-Q2");
    expect(previousQuarter("2026-Q2", 1)).toBe("2026-Q1");
    expect(previousQuarter("2026-Q2", 4)).toBe("2026-Q1");
  });
});

describe("expectedRelease", () => {
  it("is the quarter's last day plus thirty days", () => {
    expect(CPI_RELEASE_LAG_DAYS).toBe(30);
    expect(expectedRelease("2026-Q2")).toBe("2026-07-30");
    expect(expectedRelease("2026-Q4")).toBe("2027-01-30");
    expect(expectedRelease("2026-Q1")).toBe("2026-04-30");
  });
});

describe("buildCpiSuggestion", () => {
  const BASE = "Sep 2025 = 100.0";
  const rows = (...entries: Array<[string, number, string | null]>): CpiIndexRow[] =>
    entries.map(([period, indexValue, referenceBase]) => ({ indexValue, period, referenceBase }));
  const input = { intervalMonths: 12, region: "DARWIN", reviewDate: "2026-07-01" };

  it("offers both values when the reference quarter and the earlier one are published on one base", () => {
    const suggestion = buildCpiSuggestion({ ...input, rows: rows(["2026-Q2", 103.2, BASE], ["2025-Q2", 99.1, BASE], ["2025-Q3", 99.66, BASE]) });
    expect(suggestion).toEqual({
      expectedRelease: null,
      previousQuarter: "2025-Q2",
      referenceQuarter: "2026-Q2",
      region: "DARWIN",
      rule: "quarter_before_review_date",
      values: { current: 103.2, previous: 99.1, referenceBase: BASE },
    });
  });

  it("returns no values, and says when ABS is expected to publish, while the reference quarter is missing", () => {
    const suggestion = buildCpiSuggestion({ ...input, rows: rows(["2026-Q1", 102.5, BASE], ["2025-Q2", 99.1, BASE]) });
    expect(suggestion.values).toBeNull();
    expect(suggestion.referenceQuarter).toBe("2026-Q2");
    expect(suggestion.expectedRelease).toBe("2026-07-30");
  });

  it("returns no values when only the earlier quarter is missing, without promising a release", () => {
    const suggestion = buildCpiSuggestion({ ...input, rows: rows(["2026-Q2", 103.2, BASE]) });
    expect(suggestion.values).toBeNull();
    expect(suggestion.expectedRelease).toBeNull();
  });

  it("will not compare values on different bases", () => {
    const suggestion = buildCpiSuggestion({ ...input, rows: rows(["2026-Q2", 103.2, BASE], ["2025-Q2", 99.1, "Dec 2011 = 100.0"]) });
    expect(suggestion.values).toBeNull();
  });

  it("will not use values whose base is unknown", () => {
    expect(buildCpiSuggestion({ ...input, rows: rows(["2026-Q2", 103.2, null], ["2025-Q2", 99.1, null]) }).values).toBeNull();
    expect(buildCpiSuggestion({ ...input, rows: rows(["2026-Q2", 103.2, BASE], ["2025-Q2", 99.1, null]) }).values).toBeNull();
  });

  it("will not use a value that is not a number", () => {
    expect(buildCpiSuggestion({ ...input, rows: rows(["2026-Q2", Number.NaN, BASE], ["2025-Q2", 99.1, BASE]) }).values).toBeNull();
  });

  it("follows the review interval for the earlier value", () => {
    const suggestion = buildCpiSuggestion({
      intervalMonths: 24,
      region: "AUS",
      reviewDate: "2026-07-01",
      rows: rows(["2026-Q2", 103.2, BASE], ["2025-Q2", 99.1, BASE], ["2024-Q2", 97.4, BASE]),
    });
    expect(suggestion.previousQuarter).toBe("2024-Q2");
    expect(suggestion.values).toEqual({ current: 103.2, previous: 97.4, referenceBase: BASE });
  });
});
