/// <reference types="jest" />
// WP32 additions to the option rules (leaseOptions.ts): a known count of
// options left decides the window; C10's inside-the-window test; the option
// term's dates (Darwin calendar dates, month-end safe, no clock) and its rows.
// The frontend's src/helpers/leaseOptions.test.ts holds the same vectors.
import { buildOptionTermSteps, isInsideOptionWindow, optionNoticeWindow, optionTermDates } from "../leaseOptions";

const ids = () => {
  let n = 0;
  return () => `row-${++n}`;
};

describe("optionNoticeWindow with a structured count", () => {
  const tenant = { expiry: "2027-06-30", optionNoticeMonths: 6, optionPeriods: "2 x 5 years" };

  it("treats 0 left as nothing to exercise, whatever the text says", () => {
    expect(optionNoticeWindow({ ...tenant, optionsRemaining: 0 }, "2026-10-01").state).toBe("none");
  });

  it("dates the window from a count even when the text doesn't parse", () => {
    expect(optionNoticeWindow({ ...tenant, optionPeriods: "Two options of five years", optionsRemaining: 1 }, "2026-10-01")).toEqual({
      deadline: "2026-12-30",
      opensAt: "2026-06-30",
      state: "open",
    });
  });

  it("falls back to the text when the count is unknown", () => {
    expect(optionNoticeWindow({ ...tenant, optionsRemaining: null }, "2026-10-01").state).toBe("open");
    expect(optionNoticeWindow({ ...tenant, optionPeriods: "Nil", optionsRemaining: null }, "2026-10-01").state).toBe("none");
  });
});

describe("isInsideOptionWindow (C10)", () => {
  const window = { deadline: "2026-12-31", opensAt: "2026-06-30" };
  it("includes both ends and nothing outside them", () => {
    expect(isInsideOptionWindow(window, "2026-06-30")).toBe(true);
    expect(isInsideOptionWindow(window, "2026-12-31")).toBe(true);
    expect(isInsideOptionWindow(window, "2026-06-29")).toBe(false);
    expect(isInsideOptionWindow(window, "2027-01-01")).toBe(false);
    expect(isInsideOptionWindow({ deadline: null, opensAt: null }, "2026-07-01")).toBe(false);
    expect(isInsideOptionWindow(window, "2026-02-30")).toBe(false);
  });
});

describe("optionTermDates", () => {
  it("starts the day after expiry and ends the day before the same date a term later", () => {
    expect(optionTermDates("2027-06-30", 60)).toEqual({ newExpiry: "2032-06-30", optionStart: "2027-07-01", termEnd: "2032-07-01" });
  });

  it("is month-end safe: a lease ending 28 Feb runs to the end of February, 29 Feb in a leap year", () => {
    expect(optionTermDates("2027-02-28", 60)).toEqual({ newExpiry: "2032-02-29", optionStart: "2027-03-01", termEnd: "2032-03-01" });
    expect(optionTermDates("2028-02-29", 12)).toEqual({ newExpiry: "2029-02-28", optionStart: "2028-03-01", termEnd: "2029-03-01" });
    expect(optionTermDates("2027-04-30", 36)).toEqual({ newExpiry: "2030-04-30", optionStart: "2027-05-01", termEnd: "2030-05-01" });
  });

  it("clamps a start on the 31st into shorter months without drifting", () => {
    expect(optionTermDates("2027-01-30", 1)).toEqual({ newExpiry: "2027-02-27", optionStart: "2027-01-31", termEnd: "2027-02-28" });
    expect(optionTermDates("2027-12-31", 24)).toEqual({ newExpiry: "2029-12-31", optionStart: "2028-01-01", termEnd: "2030-01-01" });
  });

  it("crosses the October and April daylight-saving changes elsewhere without moving a day (Darwin has none)", () => {
    expect(optionTermDates("2026-10-03", 6)).toEqual({ newExpiry: "2027-04-03", optionStart: "2026-10-04", termEnd: "2027-04-04" });
  });

  it("is null without a real expiry or a whole term", () => {
    expect(optionTermDates(null, 60)).toBeNull();
    expect(optionTermDates("2027-02-30", 60)).toBeNull();
    expect(optionTermDates("2027-06-30", 0)).toBeNull();
    expect(optionTermDates("2027-06-30", 2.5)).toBeNull();
  });
});

describe("buildOptionTermSteps", () => {
  it("puts the start method on the first day, the ongoing one on every interval after, ending on the new expiry", () => {
    const steps = buildOptionTermSteps("2027-06-30", 60, { fixedPercent: 3, intervalMonths: 12, ongoingMethod: "fixed", startMethod: "market" }, ids());
    expect(steps.map((s) => [s.effectiveFrom, s.effectiveTo, s.methodKind, s.ratePercent])).toEqual([
      ["2027-07-01", "2028-07-01", "market", 0],
      ["2028-07-01", "2029-07-01", "fixed", 3],
      ["2029-07-01", "2030-07-01", "fixed", 3],
      ["2030-07-01", "2031-07-01", "fixed", 3],
      ["2031-07-01", "2032-07-01", "fixed", 3],
    ]);
    expect(steps.map((s) => s.id)).toEqual(["row-1", "row-2", "row-3", "row-4", "row-5"]);
  });

  it("ends a last short interval on the term's end", () => {
    const steps = buildOptionTermSteps("2027-06-30", 30, { intervalMonths: 12, ongoingMethod: "cpi", startMethod: "cpi" }, ids());
    expect(steps.map((s) => [s.effectiveFrom, s.effectiveTo])).toEqual([
      ["2027-07-01", "2028-07-01"],
      ["2028-07-01", "2029-07-01"],
      ["2029-07-01", "2030-01-01"],
    ]);
  });

  it("defaults to yearly reviews and carries no rate on CPI, market or other rows", () => {
    const steps = buildOptionTermSteps("2028-02-28", 24, { fixedPercent: 4, intervalMonths: null, ongoingMethod: "cpi", startMethod: "other" }, ids());
    expect(steps.map((s) => [s.effectiveFrom, s.effectiveTo, s.ratePercent])).toEqual([
      ["2028-02-29", "2029-02-28", 0],
      ["2029-02-28", "2030-02-28", 0],
    ]);
  });

  it("is empty when the term can't be dated", () => {
    expect(buildOptionTermSteps(null, 60, { ongoingMethod: "cpi", startMethod: "cpi" }, ids())).toEqual([]);
  });
});
