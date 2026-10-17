/// <reference types="jest" />
// Copied from command-centre src/__tests__/helpers/leaseOptions.test.ts (WP19): the same cases, run
// against the backend port. Add a case in both repos or neither.
import { optionNoticeWindow, parseOptionPeriods } from "../leaseOptions";
import type { OptionNoticeTenant } from "../leaseOptions";

// No test here reads the clock: every date, `today` included, is passed in, so
// absolute dates cannot rot.

describe("parseOptionPeriods", () => {
  describe("reads the register's option wording", () => {
    it.each([
      ["2 x 5 years", { count: 2, termMonths: 60 }],
      ["1x3yrs", { count: 1, termMonths: 36 }],
      ["5 + 5", { count: 2, termMonths: 60 }],
      ["5+5", { count: 2, termMonths: 60 }],
      ["3 + 3 + 3 years", { count: 3, termMonths: 36 }],
      ["1 × 5yr", { count: 1, termMonths: 60 }],
      ["2 X 5 YEARS", { count: 2, termMonths: 60 }],
      ["1 x 5", { count: 1, termMonths: 60 }],
      ["5 years", { count: 1, termMonths: 60 }],
      ["1 x 6 months", { count: 1, termMonths: 6 }],
      ["6 + 6 months", { count: 2, termMonths: 6 }],
      ["1 x 5 yrs + 1 x 5 yrs", { count: 2, termMonths: 60 }],
      ["5 and 5 years", { count: 2, termMonths: 60 }],
      ["2 x 5 year options", { count: 2, termMonths: 60 }],
      ["  2 x 5 years  ", { count: 2, termMonths: 60 }],
      ["1 x 2.5 years", { count: 1, termMonths: 30 }],
    ])("%j", (text, expected) => {
      expect(parseOptionPeriods(text)).toEqual(expected);
    });
  });

  describe("returns null when there is nothing exercisable or nothing clear", () => {
    it.each([
      "Nil",
      "None",
      "N/A",
      "n/a",
      "No options",
      "",
      "   ",
      "5",
      "0 x 5 years",
      "1 x 0 years",
      "5 + 3",
      "2 x 5 years + 1 x 3 years",
      "1 x 5 years then 1 x 3 years",
      "2 x 5 years (tenant's option)",
      "1 x 5 weeks",
      "see lease clause 4",
    ])("%j", (text) => {
      expect(parseOptionPeriods(text)).toBeNull();
    });

    it("for missing text", () => {
      expect(parseOptionPeriods(null)).toBeNull();
      expect(parseOptionPeriods(undefined)).toBeNull();
    });
  });
});

describe("optionNoticeWindow", () => {
  // Expiry 30-Jun-2028 with 6 months' notice: deadline 30-Dec-2027, window
  // opens 30-Jun-2027.
  const lease = (
    overrides: Partial<OptionNoticeTenant> = {},
  ): OptionNoticeTenant => ({
    expiry: "2028-06-30",
    optionNoticeMonths: 6,
    optionPeriods: "1 x 5 years",
    ...overrides,
  });

  describe("states", () => {
    it.each([
      ["2024-01-01", "not_yet"],
      ["2027-06-29", "not_yet"], // the day before the window opens
      ["2027-06-30", "open"], // the day it opens
      ["2027-09-15", "open"],
      ["2027-12-30", "open"], // the deadline itself
      ["2027-12-31", "closed"], // the day after
      ["2028-07-01", "closed"], // after the lease has expired
    ])("on %s the window is %s", (today, state) => {
      expect(optionNoticeWindow(lease(), today).state).toBe(state);
    });

    it("reports the dates of the window, from a date or a full ISO timestamp", () => {
      const dated = { deadline: "2027-12-30", opensAt: "2027-06-30", state: "open" };
      expect(optionNoticeWindow(lease(), "2027-09-15")).toEqual(dated);
      expect(
        optionNoticeWindow(lease({ expiry: "2028-06-30T00:00:00.000Z" }), "2027-09-15"),
      ).toEqual(dated);
    });
  });

  describe("is none when there is nothing to exercise or nothing to date", () => {
    const none = { deadline: null, opensAt: null, state: "none" };

    it.each(["Nil", "None", "N/A", "", "5 + 3", "free text, see lease"])(
      "for option text %j",
      (optionPeriods) => {
        expect(optionNoticeWindow(lease({ optionPeriods }), "2027-09-15")).toEqual(none);
      },
    );

    it("when option text is missing", () => {
      expect(
        optionNoticeWindow(lease({ optionPeriods: undefined }), "2027-09-15"),
      ).toEqual(none);
    });

    it.each([undefined, 0, -3, 1.5])("when the notice period is %j", (months) => {
      expect(
        optionNoticeWindow(lease({ optionNoticeMonths: months }), "2027-09-15"),
      ).toEqual(none);
    });

    it.each([undefined, "", "2028-02-30", "2028-13-01", "2028-06"])(
      "when expiry is %j",
      (expiry) => {
        expect(optionNoticeWindow(lease({ expiry }), "2027-09-15")).toEqual(none);
      },
    );

    it("when today is not a real date", () => {
      expect(optionNoticeWindow(lease(), "not-a-date")).toEqual(none);
    });
  });

  describe("is end-of-month safe", () => {
    const deadlineFor = (expiry: string, optionNoticeMonths: number) =>
      optionNoticeWindow(lease({ expiry, optionNoticeMonths }), "2000-01-01").deadline;
    const opensAtFor = (expiry: string, optionNoticeMonths: number) =>
      optionNoticeWindow(lease({ expiry, optionNoticeMonths }), "2000-01-01").opensAt;

    it("31 Aug less 6 months is the last day of February, never 3 March", () => {
      expect(deadlineFor("2027-08-31", 6)).toBe("2027-02-28");
      expect(deadlineFor("2028-08-31", 6)).toBe("2028-02-29");
    });

    it("clamps the window opening the same way when the deadline is the 31st", () => {
      // Deadline 31-Aug less 6 months.
      expect(deadlineFor("2027-12-31", 4)).toBe("2027-08-31");
      expect(opensAtFor("2027-12-31", 4)).toBe("2027-02-28");
      expect(opensAtFor("2028-12-31", 4)).toBe("2028-02-29");
    });

    it("clamps into 30-day months", () => {
      expect(deadlineFor("2027-05-31", 1)).toBe("2027-04-30");
      // Deadline 31-Oct less 6 months.
      expect(deadlineFor("2027-01-31", 3)).toBe("2026-10-31");
      expect(opensAtFor("2027-01-31", 3)).toBe("2026-04-30");
    });

    it("31 Mar less 1 month is the last day of February", () => {
      expect(deadlineFor("2027-03-31", 1)).toBe("2027-02-28");
      expect(deadlineFor("2028-03-31", 1)).toBe("2028-02-29");
    });

    it("keeps an ordinary day of the month across year boundaries", () => {
      expect(deadlineFor("2028-02-10", 12)).toBe("2027-02-10");
      expect(deadlineFor("2028-02-10", 18)).toBe("2026-08-10");
      expect(deadlineFor("2028-02-10", 24)).toBe("2026-02-10");
    });

    it("29 Feb less whole years lands on 28 Feb, or 29 Feb in a leap year", () => {
      expect(deadlineFor("2028-02-29", 12)).toBe("2027-02-28");
      expect(deadlineFor("2028-02-29", 24)).toBe("2026-02-28");
      expect(deadlineFor("2028-02-29", 48)).toBe("2024-02-29");
    });

    it("closes on the clamped deadline, not days after it", () => {
      // 31-Aug-2027 expiry, 6 months' notice: deadline 28-Feb-2027. Arithmetic
      // that overflows lands on 3-Mar and would leave 1 and 2 March "open".
      const tenant = lease({ expiry: "2027-08-31" });
      expect(optionNoticeWindow(tenant, "2026-08-27").state).toBe("not_yet");
      expect(optionNoticeWindow(tenant, "2026-08-28").state).toBe("open");
      expect(optionNoticeWindow(tenant, "2027-02-28").state).toBe("open");
      expect(optionNoticeWindow(tenant, "2027-03-01").state).toBe("closed");
      expect(optionNoticeWindow(tenant, "2027-03-02").state).toBe("closed");
    });
  });
});
