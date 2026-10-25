/// <reference types="jest" />
import { financialYear, financialYearOf, isInFinancialYear, parseFinancialYear, queryWindow } from "./financialYear";

// Australian financial years: 1 July to 30 June, on the Darwin calendar (UTC+09:30, no daylight saving).

describe("financialYear", () => {
  it("names a year the way staff say it, 1 July to 30 June", () => {
    expect(financialYear(2025)).toEqual({ from: "2025-07-01", label: "2025-26", startYear: 2025, to: "2026-06-30" });
    expect(financialYear(2099).label).toBe("2099-00");
    expect(financialYear(2008).label).toBe("2008-09");
  });

  it("puts a Darwin date in the year it falls in, either side of 1 July", () => {
    expect(financialYearOf("2026-06-30").label).toBe("2025-26");
    expect(financialYearOf("2026-07-01").label).toBe("2026-27");
    expect(financialYearOf("2026-01-01").label).toBe("2025-26");
    expect(financialYearOf("2026-12-31").label).toBe("2026-27");
  });
});

describe("parseFinancialYear", () => {
  const today = "2026-10-23";

  it("is the current year when none is asked for", () => {
    for (const none of [undefined, null, "", "  "]) expect(parseFinancialYear(none, today)).toMatchObject({ label: "2026-27" });
    expect(parseFinancialYear(undefined, "2026-06-30")).toMatchObject({ label: "2025-26" });
  });

  it("reads a label, and allows one year ahead for a clock that is a little fast on 1 July", () => {
    expect(parseFinancialYear("2025-26", today)).toMatchObject({ from: "2025-07-01", to: "2026-06-30" });
    expect(parseFinancialYear(" 2027-28 ", today)).toMatchObject({ label: "2027-28" });
    expect(parseFinancialYear("2099-00", "2098-08-01")).toMatchObject({ label: "2099-00" });
  });

  it.each([["2025"], ["2025-2026"], ["25-26"], ["2025-27"], ["2025/26"], ["abc"], ["2025-26x"], ["2099-00"], ["1999-00"], ["2028-29"]])(
    "refuses %s with a plain message",
    (raw) => {
      const result = parseFinancialYear(raw, today);
      expect(result).toEqual({ error: expect.stringContaining("financialYear must") });
    },
  );
});

describe("isInFinancialYear", () => {
  const year = financialYear(2025);

  it("reads the instant in Darwin time, not UTC", () => {
    // 23:30 Darwin on 30 June is 14:00 UTC the same day: still 2025-26.
    expect(isInFinancialYear(new Date("2026-06-30T14:00:00Z"), year)).toBe(true);
    // Midnight Darwin on 1 July is 14:30 UTC on 30 June: 2026-27.
    expect(isInFinancialYear(new Date("2026-06-30T14:29:59Z"), year)).toBe(true);
    expect(isInFinancialYear(new Date("2026-06-30T14:30:00Z"), year)).toBe(false);
    // 23:30 UTC on 30 June is 09:00 Darwin on 1 July: a UTC reading would get this one wrong.
    expect(isInFinancialYear(new Date("2026-06-30T23:30:00Z"), year)).toBe(false);
    expect(isInFinancialYear(new Date("2025-06-30T14:29:59Z"), year)).toBe(false);
    expect(isInFinancialYear(new Date("2025-06-30T14:30:00Z"), year)).toBe(true);
  });
});

describe("queryWindow", () => {
  it("brackets the whole year, so the read can never leave out an invoice the build would count", () => {
    const year = financialYear(2025);
    const { from, to } = queryWindow(year);
    expect(from.getTime()).toBeLessThanOrEqual(new Date("2025-06-30T14:30:00Z").getTime());
    expect(to.getTime()).toBeGreaterThan(new Date("2026-06-30T14:30:00Z").getTime());
  });
});
