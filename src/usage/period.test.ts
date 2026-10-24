/// <reference types="jest" />
import { MAX_PERIOD_DAYS, parsePeriod } from "./period";

// 2026-10-24 03:00 UTC is 12:30 on 24 October in Darwin.
const NOW = new Date("2026-10-24T03:00:00.000Z");
const parse = (qs: string) => parsePeriod(new URLSearchParams(qs), NOW);

describe("parsePeriod", () => {
  it("counts days back from today in Darwin, today included", () => {
    expect(parse("days=7")).toMatchObject({ period: { days: 7, from: "2026-10-18", to: "2026-10-24" } });
    expect(parse("")).toMatchObject({ period: { days: 30, from: "2026-09-25", to: "2026-10-24" } });
  });

  it("uses the Darwin day, which is ahead of UTC late in the day", () => {
    const late = parsePeriod(new URLSearchParams("days=1"), new Date("2026-10-23T15:00:00.000Z"));
    expect(late).toMatchObject({ period: { from: "2026-10-24", to: "2026-10-24" } });
  });

  it("turns days into UTC instants at Darwin midnight", () => {
    const parsed = parse("from=2026-10-20&to=2026-10-21");
    if (!("period" in parsed)) throw new Error("expected a period");
    expect(parsed.period.fromUtc.toISOString()).toBe("2026-10-19T14:30:00.000Z");
    expect(parsed.period.toUtc.toISOString()).toBe("2026-10-21T14:30:00.000Z");
    expect(parsed.period.days).toBe(2);
  });

  it.each([
    ["days=0"],
    ["days=367"],
    ["days=abc"],
    ["days=1.5"],
    ["from=2026-10-20"],
    ["to=2026-10-20"],
    ["from=2026-10-21&to=2026-10-20"],
    ["from=2026-02-30&to=2026-03-01"],
    ["from=20-10-2026&to=21-10-2026"],
    ["from=2025-01-01&to=2026-10-24"],
  ])("refuses %s", (qs) => {
    expect(parse(qs)).toHaveProperty("error");
  });

  it("allows exactly the longest period", () => {
    expect(parse(`days=${MAX_PERIOD_DAYS}`)).toHaveProperty("period");
  });
});
