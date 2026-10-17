/// <reference types="jest" />

import { checkMyobPeriod, periodStart } from "./myob-period";

// 14 Oct 2026 08:00 in Darwin is 13 Oct 22:30 UTC: the UTC date is a day behind.
const NOW = new Date("2026-10-13T22:30:00Z");
const original = process.env.MYOB_PERIOD_START;

afterEach(() => {
  if (original === undefined) delete process.env.MYOB_PERIOD_START;
  else process.env.MYOB_PERIOD_START = original;
});

describe("periodStart", () => {
  it("defaults to the first day of the current Darwin month", () => {
    delete process.env.MYOB_PERIOD_START;
    expect(periodStart(NOW)).toEqual({ date: "2026-10-01", ok: true });
  });

  it("uses MYOB_PERIOD_START when it is a date, and fails closed when it is not", () => {
    process.env.MYOB_PERIOD_START = "2026-10-10";
    expect(periodStart(NOW)).toEqual({ date: "2026-10-10", ok: true });
    process.env.MYOB_PERIOD_START = "10/10/2026";
    expect(periodStart(NOW).ok).toBe(false);
  });
});

describe("checkMyobPeriod for a create (dated today)", () => {
  beforeEach(() => delete process.env.MYOB_PERIOD_START);

  it.each(["2026-10-14", "2026-10-14T00:00:00", "2026-10-14T00:00:00.000Z"])("accepts today in Darwin: %s", (date) => {
    expect(checkMyobPeriod("today", { Date: date }, NOW)).toEqual({ ok: true });
  });

  it("accepts a JSON string body", () => {
    expect(checkMyobPeriod("today", JSON.stringify({ Date: "2026-10-14" }), NOW).ok).toBe(true);
  });

  it("refuses yesterday, the UTC date before 09:30 Darwin", () => {
    const verdict = checkMyobPeriod("today", { Date: "2026-10-13" }, NOW);
    expect(verdict).toMatchObject({ ok: false });
    expect(!verdict.ok && verdict.reason).toContain("dated today in Darwin (2026-10-14)");
  });

  it("refuses a backdated record in a prior period", () => {
    const verdict = checkMyobPeriod("today", { Date: "2026-09-30" }, NOW);
    expect(!verdict.ok && verdict.reason).toContain("before the current period (2026-10-01)");
  });

  it("refuses a date before Johanne's lock date even if it is today", () => {
    process.env.MYOB_PERIOD_START = "2026-10-15";
    expect(checkMyobPeriod("today", { Date: "2026-10-14" }, NOW).ok).toBe(false);
  });

  it.each([
    ["no Date", {}],
    ["a non-date", { Date: "14/10/2026" }],
    ["an impossible date", { Date: "2026-02-30" }],
    ["a time other than midnight", { Date: "2026-10-14T13:00:00" }],
    ["form data", new URLSearchParams({ Date: "2026-10-14" })],
    ["unparseable text", "Date=2026-10-14"],
    ["no body", undefined],
  ])("refuses %s", (_label, body) => {
    expect(checkMyobPeriod("today", body, NOW).ok).toBe(false);
  });
});

describe("checkMyobPeriod for an update (inside the period)", () => {
  beforeEach(() => delete process.env.MYOB_PERIOD_START);

  it("accepts an earlier day in the current period", () => {
    expect(checkMyobPeriod("period", { Date: "2026-10-02" }, NOW).ok).toBe(true);
  });

  it("refuses a record dated in a prior period, and one dated after today", () => {
    expect(checkMyobPeriod("period", { Date: "2026-09-29" }, NOW).ok).toBe(false);
    expect(checkMyobPeriod("period", { Date: "2026-10-15" }, NOW).ok).toBe(false);
  });
});
