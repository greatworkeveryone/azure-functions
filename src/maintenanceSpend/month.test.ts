/// <reference types="jest" />
import { isInFinancialYear, queryWindow } from "./financialYear";
import { parseMonth } from "./month";

describe("parseMonth", () => {
  it.each([
    ["2026-11", "2026-11-01", "2026-11-30"],
    ["2026-12", "2026-12-01", "2026-12-31"],
    ["2026-02", "2026-02-01", "2026-02-28"],
    ["2028-02", "2028-02-01", "2028-02-29"],
    ["2026-06", "2026-06-01", "2026-06-30"],
    ["2026-07", "2026-07-01", "2026-07-31"],
  ])("%s runs %s to %s", (raw, from, to) => {
    expect(parseMonth(raw, "2029-01-15")).toEqual({ from, label: raw, to });
  });

  it("allows one month ahead but no more, across a year end", () => {
    expect("error" in parseMonth("2026-12", "2026-11-15")).toBe(false);
    expect("error" in parseMonth("2027-01", "2026-11-15")).toBe(true);
    expect("error" in parseMonth("2027-01", "2026-12-31")).toBe(false);
  });

  it.each([["2026-13"], ["2026-00"], ["2026-1"], ["26-11"], ["1999-12"], ["2026-11-01"], ["x"]])("rejects %s", (raw) => {
    expect(parseMonth(raw, "2026-11-15")).toHaveProperty("error");
  });

  it("decides month edges in Darwin time (UTC+9:30)", () => {
    const nov = parseMonth("2026-11", "2026-11-15") as { from: string; to: string };
    expect(isInFinancialYear(new Date("2026-10-31T14:29:59Z"), nov)).toBe(false); // 23:59:59 on 31 Oct, Darwin
    expect(isInFinancialYear(new Date("2026-10-31T14:30:00Z"), nov)).toBe(true); // midnight 1 Nov, Darwin
    expect(isInFinancialYear(new Date("2026-11-30T14:29:59Z"), nov)).toBe(true);
    expect(isInFinancialYear(new Date("2026-11-30T14:30:00Z"), nov)).toBe(false);
  });

  it("brackets the SQL read around the month", () => {
    const june = parseMonth("2026-06", "2026-11-15") as { from: string; to: string };
    expect(queryWindow(june)).toEqual({ from: new Date("2026-05-31T00:00:00Z"), to: new Date("2026-07-02T00:00:00Z") });
  });
});
