/// <reference types="jest" />
import {
  addBusinessDays,
  addBusinessHours,
  addCalendarDays,
  addClockHours,
  addWallHours,
  businessDayEnd,
  businessDayStart,
  businessDaysToHours,
  businessHoursElapsed,
  darwinDateKey,
  darwinMinuteOfDay,
  holidaysFromEnv,
  isBusinessDay,
  isDateKey,
  nextBusinessDay,
  nextBusinessHoursInstant,
  NO_HOLIDAYS,
  parseHolidays,
  previousBusinessDay,
} from "./businessTime";

// 2026-10-12 is a Monday, so 13 Tue, 14 Wed, 15 Thu, 16 Fri, 17 Sat, 18 Sun, 19 Mon.
// Fixed dates are safe here: every function takes its start instant as an argument.

/** A Darwin wall-clock time ("2026-10-12 16:30") as the UTC instant it is. */
function darwin(text: string): Date {
  const [date, time = "00:00"] = text.split(" ");
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi) - 9.5 * 3_600_000);
}

/** An instant back to Darwin wall-clock text. */
function show(instant: Date): string {
  const shifted = new Date(instant.getTime() + 9.5 * 3_600_000);
  return shifted.toISOString().slice(0, 16).replace("T", " ");
}

const plus = (start: string, hours: number, holidays = NO_HOLIDAYS) => show(addBusinessHours(darwin(start), hours, holidays));

describe("the fixtures", () => {
  it("start on the weekdays the comments say", () => {
    expect(darwin("2026-10-12 12:00").getUTCDay()).toBe(1);
    expect(new Date(Date.UTC(2026, 9, 17)).getUTCDay()).toBe(6);
  });
});

describe("addBusinessHours", () => {
  it("adds within a day", () => {
    expect(plus("2026-10-12 09:00", 2)).toBe("2026-10-12 11:00");
  });

  it("counts 8 business hours from 08:30 as ending at 16:30", () => {
    expect(plus("2026-10-12 08:30", 8)).toBe("2026-10-12 16:30");
  });

  it("keeps a deadline that lands exactly on 17:00 on that day", () => {
    expect(plus("2026-10-12 08:30", 8.5)).toBe("2026-10-12 17:00");
  });

  it("rolls from 17:00 to 08:30 the next business day", () => {
    expect(plus("2026-10-12 16:00", 2)).toBe("2026-10-13 09:30");
    expect(plus("2026-10-12 16:59", 0.5)).toBe("2026-10-13 08:59");
  });

  it("starts from 08:30 when the clock starts after hours", () => {
    expect(plus("2026-10-12 17:00", 1)).toBe("2026-10-13 09:30");
    expect(plus("2026-10-12 23:45", 1)).toBe("2026-10-13 09:30");
  });

  it("starts from 08:30 when the clock starts before hours", () => {
    expect(plus("2026-10-12 07:00", 1)).toBe("2026-10-12 09:30");
    expect(plus("2026-10-12 00:00", 8)).toBe("2026-10-12 16:30");
  });

  it("skips weekends", () => {
    expect(plus("2026-10-16 16:30", 1)).toBe("2026-10-19 09:00");
    expect(plus("2026-10-17 10:00", 1)).toBe("2026-10-19 09:30");
    expect(plus("2026-10-18 10:00", 1)).toBe("2026-10-19 09:30");
  });

  it("carries across several days", () => {
    expect(plus("2026-10-12 09:00", 16)).toBe("2026-10-13 16:30");
    // 5 business days of 8h: Mon 08:30 .. Fri 14:30 (each day is 8.5h long)
    expect(plus("2026-10-12 08:30", 40)).toBe("2026-10-16 14:30");
    // across a weekend
    expect(plus("2026-10-15 16:00", 8)).toBe("2026-10-16 15:30");
    expect(plus("2026-10-16 16:00", 8)).toBe("2026-10-19 15:30");
  });

  it("skips public holidays from ESCALATION_HOLIDAYS", () => {
    const tuesdayOff = parseHolidays("2026-10-13").holidays;
    expect(plus("2026-10-12 16:00", 2, tuesdayOff)).toBe("2026-10-14 09:30");

    const fridayOff = parseHolidays("2026-10-16").holidays;
    expect(plus("2026-10-15 16:30", 1, fridayOff)).toBe("2026-10-19 09:00");

    const fridayAndMonday = parseHolidays("2026-10-16, 2026-10-19").holidays;
    expect(plus("2026-10-15 16:30", 1, fridayAndMonday)).toBe("2026-10-20 09:00");
  });

  it("treats a start on a holiday like a start on a weekend", () => {
    const tuesdayOff = parseHolidays("2026-10-13").holidays;
    expect(plus("2026-10-13 10:00", 1, tuesdayOff)).toBe("2026-10-14 09:30");
  });

  it("returns the same instant for zero hours, even outside business hours", () => {
    const sunday = darwin("2026-10-18 03:00");
    expect(addBusinessHours(sunday, 0).getTime()).toBe(sunday.getTime());
  });

  it("accepts fractions of an hour", () => {
    expect(plus("2026-10-12 09:00", 0.25)).toBe("2026-10-12 09:15");
    expect(plus("2026-10-12 16:45", 0.5)).toBe("2026-10-13 08:45");
  });

  it("refuses hours that are negative or not numbers", () => {
    expect(() => addBusinessHours(darwin("2026-10-12 09:00"), -1)).toThrow(RangeError);
    expect(() => addBusinessHours(darwin("2026-10-12 09:00"), Number.NaN)).toThrow(RangeError);
    expect(() => addBusinessHours(darwin("2026-10-12 09:00"), Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("gives up on a holiday list with no business day in ten years", () => {
    const days: string[] = [];
    for (let i = 0; i < 4000; i += 1) {
      days.push(new Date(Date.UTC(2026, 9, 12) + i * 86_400_000).toISOString().slice(0, 10));
    }
    const everyDay = parseHolidays(days.join(",")).holidays;
    expect(() => addBusinessHours(darwin("2026-10-12 09:00"), 1, everyDay)).toThrow(/ESCALATION_HOLIDAYS/);
  });

  it("uses Darwin's fixed offset in every month, never daylight saving", () => {
    // January and October give the same Darwin result for the same wall clock.
    expect(plus("2026-01-12 09:00", 1)).toBe("2026-01-12 10:00");
    expect(plus("2026-07-13 09:00", 1)).toBe("2026-07-13 10:00");
    expect(plus("2026-10-12 09:00", 1)).toBe("2026-10-12 10:00");
  });

  it("does not depend on the process time zone", () => {
    const original = process.env.TZ;
    const results: string[] = [];
    try {
      for (const tz of ["UTC", "America/New_York", "Europe/Copenhagen", "Australia/Sydney"]) {
        process.env.TZ = tz;
        results.push(plus("2026-10-12 16:00", 2), plus("2026-10-16 16:30", 1));
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
    expect(new Set(results)).toEqual(new Set(["2026-10-13 09:30", "2026-10-19 09:00"]));
  });
});

describe("addWallHours", () => {
  it("counts every hour, through the night and the weekend", () => {
    expect(show(addWallHours(darwin("2026-10-16 20:00"), 4))).toBe("2026-10-17 00:00");
    expect(show(addWallHours(darwin("2026-10-16 17:00"), 2))).toBe("2026-10-16 19:00");
  });

  it("is what clock = wall uses (job.critical: 2h, then 4h)", () => {
    const raised = darwin("2026-10-17 03:00"); // a Saturday, in the small hours
    expect(show(addClockHours("wall", raised, 2))).toBe("2026-10-17 05:00");
    expect(show(addClockHours("business", raised, 2))).toBe("2026-10-19 10:30");
  });

  it("refuses negative hours", () => {
    expect(() => addWallHours(darwin("2026-10-12 09:00"), -2)).toThrow(RangeError);
  });
});

describe("parseHolidays and holidaysFromEnv", () => {
  it("reads comma-separated dates, trimming spaces and ignoring empties", () => {
    const { holidays, invalid } = parseHolidays(" 2026-12-25 ,2026-12-26,, 2027-01-01 ");
    expect([...holidays].sort()).toEqual(["2026-12-25", "2026-12-26", "2027-01-01"]);
    expect(invalid).toEqual([]);
  });

  it("reports entries that are not real YYYY-MM-DD dates", () => {
    const { holidays, invalid } = parseHolidays("2026-12-25, 25/12/2026, 2026-02-30, christmas");
    expect([...holidays]).toEqual(["2026-12-25"]);
    expect(invalid).toEqual(["25/12/2026", "2026-02-30", "christmas"]);
  });

  it("is empty for unset or blank", () => {
    expect(parseHolidays(undefined).holidays.size).toBe(0);
    expect(parseHolidays("").holidays.size).toBe(0);
  });

  it("holidaysFromEnv follows the variable, and re-reads when it changes", () => {
    expect(holidaysFromEnv({ ESCALATION_HOLIDAYS: "2026-10-13" } as NodeJS.ProcessEnv).has("2026-10-13")).toBe(true);
    expect(holidaysFromEnv({} as NodeJS.ProcessEnv).size).toBe(0);
    expect(holidaysFromEnv({ ESCALATION_HOLIDAYS: "2026-10-14" } as NodeJS.ProcessEnv).has("2026-10-13")).toBe(false);
  });

  it("addBusinessHours reads ESCALATION_HOLIDAYS when no list is passed", () => {
    const original = process.env.ESCALATION_HOLIDAYS;
    process.env.ESCALATION_HOLIDAYS = "2026-10-13";
    try {
      expect(show(addBusinessHours(darwin("2026-10-12 16:00"), 2))).toBe("2026-10-14 09:30");
    } finally {
      if (original === undefined) delete process.env.ESCALATION_HOLIDAYS;
      else process.env.ESCALATION_HOLIDAYS = original;
    }
    expect(show(addBusinessHours(darwin("2026-10-12 16:00"), 2))).toBe("2026-10-13 09:30");
  });
});

describe("isBusinessDay", () => {
  it("is true Monday to Friday and false on weekends and holidays", () => {
    expect(isBusinessDay("2026-10-12", NO_HOLIDAYS)).toBe(true);
    expect(isBusinessDay("2026-10-16", NO_HOLIDAYS)).toBe(true);
    expect(isBusinessDay("2026-10-17", NO_HOLIDAYS)).toBe(false);
    expect(isBusinessDay("2026-10-18", NO_HOLIDAYS)).toBe(false);
    expect(isBusinessDay("2026-10-13", parseHolidays("2026-10-13").holidays)).toBe(false);
  });

  it("refuses text that is not a date", () => {
    expect(() => isBusinessDay("13/10/2026", NO_HOLIDAYS)).toThrow(RangeError);
  });
});

describe("businessHoursElapsed and businessDaysToHours", () => {
  it("is false until the business hours have passed, true from the moment they have", () => {
    const since = darwin("2026-10-12 09:00");
    expect(businessHoursElapsed(since, 8, darwin("2026-10-12 16:59"), NO_HOLIDAYS)).toBe(false);
    expect(businessHoursElapsed(since, 8, darwin("2026-10-12 17:00"), NO_HOLIDAYS)).toBe(true);
    // 16 business hours from Monday 09:00 end Tuesday 16:30
    expect(businessHoursElapsed(since, 16, darwin("2026-10-13 16:30"), NO_HOLIDAYS)).toBe(true);
    expect(businessHoursElapsed(since, 16, darwin("2026-10-13 16:29"), NO_HOLIDAYS)).toBe(false);
  });

  it("counts a business day as 8 hours (PLAN §3.7)", () => {
    expect(businessDaysToHours(1)).toBe(8);
    expect(businessDaysToHours(3)).toBe(24);
    expect(businessDaysToHours(5)).toBe(40);
  });
});

describe("Darwin calendar helpers", () => {
  it("puts an evening UTC instant on the next Darwin day", () => {
    expect(darwinDateKey(new Date("2026-10-12T15:30:00Z"))).toBe("2026-10-13");
    expect(darwinDateKey(new Date("2026-10-12T14:29:00Z"))).toBe("2026-10-12");
  });

  it("gives the Darwin minute of the day", () => {
    expect(darwinMinuteOfDay(darwin("2026-10-12 15:00"))).toBe(15 * 60);
    expect(darwinMinuteOfDay(darwin("2026-10-12 00:05"))).toBe(5);
  });
});

// ── Calendar days and the business day's edges (decision-request tiers) ─────

const days = (...dates: string[]) => parseHolidays(dates.join(",")).holidays;

describe("isDateKey", () => {
  it("accepts only a real YYYY-MM-DD date", () => {
    expect(isDateKey("2026-10-12")).toBe(true);
    expect(isDateKey("2028-02-29")).toBe(true);
    for (const bad of ["2026-02-29", "2026-13-01", "2026-10-32", "12/10/2026", "2026-1-5", "", " 2026-10-12", null, undefined, 20261012]) {
      expect(isDateKey(bad)).toBe(false);
    }
  });
});

describe("addCalendarDays", () => {
  it("moves a date by whole days, across month and year ends and in either direction", () => {
    expect(addCalendarDays("2026-10-12", 7)).toBe("2026-10-19");
    expect(addCalendarDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addCalendarDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addCalendarDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addCalendarDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(addCalendarDays("2026-10-12", 0)).toBe("2026-10-12");
  });

  it("refuses a part of a day and text that is not a date", () => {
    expect(() => addCalendarDays("2026-10-12", 1.5)).toThrow(RangeError);
    expect(() => addCalendarDays("tomorrow", 1)).toThrow(RangeError);
  });
});

describe("nextBusinessDay and previousBusinessDay", () => {
  it("return a business day as it is", () => {
    expect(nextBusinessDay("2026-10-12", NO_HOLIDAYS)).toBe("2026-10-12");
    expect(previousBusinessDay("2026-10-16", NO_HOLIDAYS)).toBe("2026-10-16");
  });

  it("skip the weekend in each direction", () => {
    expect(nextBusinessDay("2026-10-17", NO_HOLIDAYS)).toBe("2026-10-19");
    expect(nextBusinessDay("2026-10-18", NO_HOLIDAYS)).toBe("2026-10-19");
    expect(previousBusinessDay("2026-10-17", NO_HOLIDAYS)).toBe("2026-10-16");
    expect(previousBusinessDay("2026-10-18", NO_HOLIDAYS)).toBe("2026-10-16");
  });

  it("skip public holidays, a run of them included", () => {
    expect(nextBusinessDay("2026-10-19", days("2026-10-19"))).toBe("2026-10-20");
    expect(previousBusinessDay("2026-10-19", days("2026-10-19"))).toBe("2026-10-16");
    // Good Friday through Easter Monday style long weekend
    const long = days("2026-10-16", "2026-10-19");
    expect(nextBusinessDay("2026-10-16", long)).toBe("2026-10-20");
    expect(previousBusinessDay("2026-10-19", long)).toBe("2026-10-15");
  });

  it("say so when a holiday list has swallowed the calendar", () => {
    const everyDay = new Set<string>();
    for (let i = 0; i < 8000; i += 1) everyDay.add(addCalendarDays("2016-01-01", i));
    expect(() => nextBusinessDay("2026-10-12", everyDay)).toThrow(RangeError);
    expect(() => previousBusinessDay("2026-10-12", everyDay)).toThrow(RangeError);
  });
});

describe("addBusinessDays", () => {
  it("counts business days strictly after the date", () => {
    expect(addBusinessDays("2026-10-12", 0, NO_HOLIDAYS)).toBe("2026-10-12");
    expect(addBusinessDays("2026-10-12", 1, NO_HOLIDAYS)).toBe("2026-10-13");
    expect(addBusinessDays("2026-10-12", 5, NO_HOLIDAYS)).toBe("2026-10-19");
  });

  it("starts from a weekend or a holiday as if from the day before it", () => {
    expect(addBusinessDays("2026-10-16", 1, NO_HOLIDAYS)).toBe("2026-10-19");
    expect(addBusinessDays("2026-10-17", 1, NO_HOLIDAYS)).toBe("2026-10-19");
    expect(addBusinessDays("2026-10-18", 1, NO_HOLIDAYS)).toBe("2026-10-19");
    expect(addBusinessDays("2026-10-16", 1, days("2026-10-19"))).toBe("2026-10-20");
    expect(addBusinessDays("2026-10-12", 3, days("2026-10-14"))).toBe("2026-10-16");
  });

  it("refuses a negative or part of a day", () => {
    expect(() => addBusinessDays("2026-10-12", -1, NO_HOLIDAYS)).toThrow(RangeError);
    expect(() => addBusinessDays("2026-10-12", 0.5, NO_HOLIDAYS)).toThrow(RangeError);
  });
});

describe("businessDayStart and businessDayEnd", () => {
  it("are 08:30 and 17:00 Darwin", () => {
    expect(show(businessDayStart("2026-10-12"))).toBe("2026-10-12 08:30");
    expect(show(businessDayEnd("2026-10-12"))).toBe("2026-10-12 17:00");
    expect(businessDayStart("2026-10-12").toISOString()).toBe("2026-10-11T23:00:00.000Z");
    expect(businessDayEnd("2026-10-12").toISOString()).toBe("2026-10-12T07:30:00.000Z");
  });

  it("do not depend on whether the day is a business day", () => {
    expect(show(businessDayEnd("2026-10-17"))).toBe("2026-10-17 17:00");
    expect(() => businessDayStart("17/10/2026")).toThrow(RangeError);
  });
});

describe("nextBusinessHoursInstant", () => {
  const next = (start: string, holidays = NO_HOLIDAYS) => show(nextBusinessHoursInstant(darwin(start), holidays));

  it("returns an instant inside business hours as it is, to the minute", () => {
    expect(next("2026-10-12 08:30")).toBe("2026-10-12 08:30");
    expect(next("2026-10-12 12:47")).toBe("2026-10-12 12:47");
    expect(next("2026-10-12 16:59")).toBe("2026-10-12 16:59");
  });

  it("waits for opening before it, and for the next business day from 17:00", () => {
    expect(next("2026-10-12 06:15")).toBe("2026-10-12 08:30");
    expect(next("2026-10-12 08:29")).toBe("2026-10-12 08:30");
    expect(next("2026-10-12 17:00")).toBe("2026-10-13 08:30");
    expect(next("2026-10-12 23:59")).toBe("2026-10-13 08:30");
  });

  it("moves a weekend or a holiday to the next business morning", () => {
    expect(next("2026-10-16 18:00")).toBe("2026-10-19 08:30");
    expect(next("2026-10-17 12:00")).toBe("2026-10-19 08:30");
    expect(next("2026-10-18 03:00")).toBe("2026-10-19 08:30");
    expect(next("2026-10-19 12:00", days("2026-10-19"))).toBe("2026-10-20 08:30");
    expect(next("2026-10-16 18:00", days("2026-10-19"))).toBe("2026-10-20 08:30");
  });

  it("is a new Date, never the one passed in", () => {
    const start = darwin("2026-10-12 12:00");
    expect(nextBusinessHoursInstant(start, NO_HOLIDAYS)).not.toBe(start);
    expect(nextBusinessHoursInstant(start, NO_HOLIDAYS).getTime()).toBe(start.getTime());
  });
});
