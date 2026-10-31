/// <reference types="jest" />
import {
  addCalendarDays,
  darwinDateKey,
  darwinMinuteOfDay,
  isBusinessDay,
  nextBusinessDay,
  NO_HOLIDAYS,
  parseHolidays,
} from "../escalation/businessTime";
import {
  DECISION_TIERS,
  FIXED_MAX_DAYS_AHEAD,
  parseTierRequest,
  scheduleFor,
  TierError,
  type DecisionTier,
  type TierRequest,
  type TierSchedule,
} from "./tiers";

// 2026-10-12 is a Monday: 13 Tue, 14 Wed, 15 Thu, 16 Fri, 17 Sat, 18 Sun, 19 Mon,
// 20 Tue, 21 Wed, 22 Thu, 23 Fri, 24 Sat, 25 Sun, 26 Mon. Every function takes its
// start instant as an argument, so fixed dates are safe.

/** A Darwin wall-clock time ("2026-10-12 16:30") as the UTC instant it is. */
function darwin(text: string): Date {
  const [date, time = "00:00"] = text.split(" ");
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi) - 9.5 * 3_600_000);
}

/** An instant back to Darwin wall-clock text. */
function show(instant: Date | null): string | null {
  if (instant === null) return null;
  return new Date(instant.getTime() + 9.5 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
}

const holidays = (...days: string[]) => parseHolidays(days.join(",")).holidays;

/** The schedule as text, so a failing case reads as dates. */
function view(schedule: TierSchedule) {
  return {
    escalateAt: show(schedule.escalateAt),
    remindAt: schedule.remindAt.map((instant) => show(instant)),
    respondBy: show(schedule.respondBy),
  };
}

const ask = (request: TierRequest, start: string, days = NO_HOLIDAYS) => view(scheduleFor(request, darwin(start), days));

describe("the fixtures", () => {
  it("start on the weekdays the comments say", () => {
    expect(darwin("2026-10-12 12:00").getUTCDay()).toBe(1);
    expect(darwin("2026-10-17 12:00").getUTCDay()).toBe(6);
  });
});

describe("emergency", () => {
  it("has no deadline, no reminders and no escalation, and tells the screen to say call them", () => {
    const schedule = scheduleFor({ tier: "emergency" }, darwin("2026-10-12 10:00"), NO_HOLIDAYS);

    expect(schedule).toEqual({
      autoEscalate: false,
      callThem: true,
      dueDate: null,
      escalateAt: null,
      fixedDate: null,
      remindAt: [],
      respondBy: null,
      routineWeeks: null,
      tier: "emergency",
      timed: false,
      urgent: true,
    });
  });

  it("is the same on a weekend, a holiday and in the small hours", () => {
    for (const start of ["2026-10-17 03:00", "2026-10-19 12:00", "2026-10-12 23:59"]) {
      const schedule = scheduleFor({ tier: "emergency" }, darwin(start), holidays("2026-10-19"));
      expect(schedule).toMatchObject({ callThem: true, escalateAt: null, remindAt: [], respondBy: null, timed: false });
    }
  });

  it("ignores the auto-escalate tick: an emergency is never chased, ticked or not", () => {
    const start = darwin("2026-10-12 10:00");
    const plain = scheduleFor({ tier: "emergency" }, start, NO_HOLIDAYS);
    for (const autoEscalate of [true, false]) {
      expect(scheduleFor({ autoEscalate, tier: "emergency" }, start, NO_HOLIDAYS)).toEqual(plain);
    }
  });
});

describe("urgent, ticked to move up: by tomorrow, reminded at 24 hours, moved up at 36", () => {
  const urgent: TierRequest = { autoEscalate: true, tier: "urgent" };

  it("asked on a Monday morning: due Tuesday close of business, reminded that morning, moved up Wednesday morning", () => {
    expect(ask(urgent, "2026-10-12 09:00")).toEqual({
      escalateAt: "2026-10-14 08:30",
      remindAt: ["2026-10-13 09:00"],
      respondBy: "2026-10-13 16:30",
    });
  });

  it("keeps the 24-hour mark to the minute when it falls in business hours", () => {
    expect(ask(urgent, "2026-10-12 16:15").remindAt).toEqual(["2026-10-13 16:15"]);
    expect(ask(urgent, "2026-10-12 08:30").remindAt).toEqual(["2026-10-13 08:30"]);
  });

  it("asked at 16:15, the respond-by is 15 minutes after the reminder", () => {
    expect(ask(urgent, "2026-10-12 16:15")).toEqual({
      escalateAt: "2026-10-14 08:30",
      remindAt: ["2026-10-13 16:15"],
      respondBy: "2026-10-13 16:30",
    });
  });

  it("asked after hours, it is still due tomorrow, with the reminder when tomorrow opens", () => {
    expect(ask(urgent, "2026-10-12 18:00")).toEqual({
      escalateAt: "2026-10-14 08:30",
      remindAt: ["2026-10-13 08:30"],
      respondBy: "2026-10-13 16:30",
    });
    expect(ask(urgent, "2026-10-12 16:30").remindAt).toEqual(["2026-10-13 08:30"]);
    expect(ask(urgent, "2026-10-12 23:59").respondBy).toBe("2026-10-13 16:30");
  });

  it("asked at 16:29, the 24-hour mark is the last minute before close", () => {
    expect(ask(urgent, "2026-10-12 16:29").remindAt).toEqual(["2026-10-13 16:29"]);
  });

  it("asked before opening, the reminder waits for the opening", () => {
    expect(ask(urgent, "2026-10-12 06:00")).toEqual({
      escalateAt: "2026-10-14 08:30",
      remindAt: ["2026-10-13 08:30"],
      respondBy: "2026-10-13 16:30",
    });
  });

  it("asked on a Friday afternoon, runs to Monday: due Monday, moved up Tuesday", () => {
    expect(ask(urgent, "2026-10-16 15:00")).toEqual({
      escalateAt: "2026-10-20 08:30",
      remindAt: ["2026-10-19 08:30"],
      respondBy: "2026-10-19 16:30",
    });
  });

  it("asked on a Thursday: due Friday, and the escalation skips the weekend", () => {
    expect(ask(urgent, "2026-10-15 11:00")).toEqual({
      escalateAt: "2026-10-19 08:30",
      remindAt: ["2026-10-16 11:00"],
      respondBy: "2026-10-16 16:30",
    });
  });

  it("asked on a weekend, it is due Monday, whatever the hour", () => {
    const monday = { escalateAt: "2026-10-20 08:30", remindAt: ["2026-10-19 08:30"], respondBy: "2026-10-19 16:30" };
    expect(ask(urgent, "2026-10-17 10:00")).toEqual(monday);
    expect(ask(urgent, "2026-10-18 22:00")).toEqual(monday);
    expect(ask(urgent, "2026-10-17 00:00")).toEqual(monday);
  });

  it("skips a public holiday on the Monday", () => {
    expect(ask(urgent, "2026-10-16 15:00", holidays("2026-10-19"))).toEqual({
      escalateAt: "2026-10-21 08:30",
      remindAt: ["2026-10-20 08:30"],
      respondBy: "2026-10-20 16:30",
    });
  });

  it("skips a public holiday on the day after the respond-by", () => {
    expect(ask(urgent, "2026-10-12 09:00", holidays("2026-10-14"))).toEqual({
      escalateAt: "2026-10-15 08:30",
      remindAt: ["2026-10-13 09:00"],
      respondBy: "2026-10-13 16:30",
    });
  });

  it("skips a public holiday on the day after the request", () => {
    expect(ask(urgent, "2026-10-12 09:00", holidays("2026-10-13"))).toEqual({
      escalateAt: "2026-10-15 08:30",
      remindAt: ["2026-10-14 08:30"],
      respondBy: "2026-10-14 16:30",
    });
  });

  it("is raised as urgent, with one reminder, and has a deadline to chase", () => {
    const schedule = scheduleFor(urgent, darwin("2026-10-12 09:00"), NO_HOLIDAYS);
    expect(schedule).toMatchObject({ autoEscalate: true, callThem: false, dueDate: "2026-10-13", routineWeeks: null, timed: true, urgent: true });
    expect(schedule.remindAt).toHaveLength(1);
  });
});

describe("urgent, not ticked to move up (the default): same deadline and reminder, nothing moves up", () => {
  const unticked: TierRequest = { tier: "urgent" };
  const ticked: TierRequest = { autoEscalate: true, tier: "urgent" };
  const explicitlyOff: TierRequest = { autoEscalate: false, tier: "urgent" };

  it("asked on a Monday morning: due Tuesday close of business, reminded that morning, never moved up", () => {
    expect(ask(unticked, "2026-10-12 09:00")).toEqual({
      escalateAt: null,
      remindAt: ["2026-10-13 09:00"],
      respondBy: "2026-10-13 16:30",
    });
  });

  it("is untouched by the tick in everything but the move-up, whenever and wherever it falls", () => {
    const calendars = [NO_HOLIDAYS, holidays("2026-10-13"), holidays("2026-10-14"), holidays("2026-10-19")];
    for (const start of [
      "2026-10-12 06:00",
      "2026-10-12 08:30",
      "2026-10-12 09:00",
      "2026-10-12 16:15",
      "2026-10-12 16:30",
      "2026-10-12 23:59",
      "2026-10-15 11:00",
      "2026-10-16 15:00",
      "2026-10-17 10:00",
      "2026-10-18 22:00",
    ]) {
      for (const days of calendars) {
        const moves = ask(ticked, start, days);
        expect(moves.escalateAt).not.toBeNull();
        expect(ask(unticked, start, days)).toEqual({ ...moves, escalateAt: null });
        expect(ask(explicitlyOff, start, days)).toEqual({ ...moves, escalateAt: null });
      }
    }
  });

  it("keeps the 24-hour reminder, so the people are still told", () => {
    const schedule = scheduleFor(unticked, darwin("2026-10-12 09:00"), NO_HOLIDAYS);
    expect(schedule.remindAt).toHaveLength(1);
    expect(show(schedule.remindAt[0])).toBe("2026-10-13 09:00");
    expect(ask(unticked, "2026-10-12 16:15").remindAt).toEqual(["2026-10-13 16:15"]);
    expect(ask(unticked, "2026-10-12 18:00").remindAt).toEqual(["2026-10-13 08:30"]);
  });

  it("is still raised as urgent and timed; only the move-up is off", () => {
    expect(scheduleFor(unticked, darwin("2026-10-12 09:00"), NO_HOLIDAYS)).toMatchObject({
      autoEscalate: false,
      callThem: false,
      dueDate: "2026-10-13",
      escalateAt: null,
      timed: true,
      urgent: true,
    });
    expect(scheduleFor(explicitlyOff, darwin("2026-10-12 09:00"), NO_HOLIDAYS).autoEscalate).toBe(false);
  });

  it("the tick turns the move-up on at the 36-hour mark", () => {
    expect(scheduleFor(ticked, darwin("2026-10-12 09:00"), NO_HOLIDAYS)).toMatchObject({ autoEscalate: true });
    expect(ask(ticked, "2026-10-12 09:00").escalateAt).toBe("2026-10-14 08:30");
  });
});

describe("soon, routine and fixed always move up", () => {
  const start = darwin("2026-10-12 10:00");
  const requests: [string, TierRequest][] = [
    ["soon", { tier: "soon" }],
    ["routine", { routineWeeks: 3, tier: "routine" }],
    ["fixed", { fixedDate: "2026-10-23", tier: "fixed" }],
  ];

  it.each(requests)("%s has a move-up at its deadline", (_tier, request) => {
    const schedule = scheduleFor(request, start, NO_HOLIDAYS);
    expect(schedule.autoEscalate).toBe(true);
    expect(schedule.escalateAt).not.toBeNull();
    expect(schedule.escalateAt).toEqual(schedule.respondBy);
  });

  it.each(requests)("%s accepts the tick set to true, which changes nothing", (_tier, request) => {
    expect(scheduleFor({ ...request, autoEscalate: true }, start, NO_HOLIDAYS)).toEqual(scheduleFor(request, start, NO_HOLIDAYS));
  });

  it.each(requests)("%s refuses to be told not to move up, whatever calls it", (_tier, request) => {
    expect(() => scheduleFor({ ...request, autoEscalate: false }, start, NO_HOLIDAYS)).toThrow(
      expect.objectContaining({ code: "auto_escalate_not_optional", name: "TierError", status: 400 }),
    );
  });
});


describe("soon: a week, reminded the business day before", () => {
  const soon: TierRequest = { tier: "soon" };

  it("asked on a Monday: due next Monday close of business, reminded the Friday before, moved up at the deadline", () => {
    expect(ask(soon, "2026-10-12 10:00")).toEqual({
      escalateAt: "2026-10-19 16:30",
      remindAt: ["2026-10-16 08:30"],
      respondBy: "2026-10-19 16:30",
    });
  });

  it("asked midweek: reminded the day before it is due", () => {
    expect(ask(soon, "2026-10-14 10:00")).toEqual({
      escalateAt: "2026-10-21 16:30",
      remindAt: ["2026-10-20 08:30"],
      respondBy: "2026-10-21 16:30",
    });
    expect(ask(soon, "2026-10-16 10:00").remindAt).toEqual(["2026-10-22 08:30"]);
  });

  it("asked on a Saturday: the week ends on a Saturday, so it is due the Monday after", () => {
    expect(ask(soon, "2026-10-17 10:00")).toEqual({
      escalateAt: "2026-10-26 16:30",
      remindAt: ["2026-10-23 08:30"],
      respondBy: "2026-10-26 16:30",
    });
  });

  it("asked on a Sunday: due the Monday a week on, reminded the Friday before", () => {
    expect(ask(soon, "2026-10-18 10:00")).toEqual({
      escalateAt: "2026-10-26 16:30",
      remindAt: ["2026-10-23 08:30"],
      respondBy: "2026-10-26 16:30",
    });
  });

  it("moves a deadline off a public holiday to the next business day, and reminds the business day before that", () => {
    expect(ask(soon, "2026-10-12 10:00", holidays("2026-10-19"))).toEqual({
      escalateAt: "2026-10-20 16:30",
      remindAt: ["2026-10-16 08:30"],
      respondBy: "2026-10-20 16:30",
    });
  });

  it("moves a reminder off a public holiday to the business day before it", () => {
    expect(ask(soon, "2026-10-14 10:00", holidays("2026-10-20"))).toEqual({
      escalateAt: "2026-10-21 16:30",
      remindAt: ["2026-10-19 08:30"],
      respondBy: "2026-10-21 16:30",
    });
  });

  it("counts the day it is asked by the Darwin calendar, not the UTC one", () => {
    // 00:30 Darwin on Tuesday 13 Oct is Monday 12 Oct 15:00 UTC.
    expect(ask(soon, "2026-10-13 00:30").respondBy).toBe("2026-10-20 16:30");
    expect(ask(soon, "2026-10-13 23:30").respondBy).toBe("2026-10-20 16:30");
  });

  it("is not urgent", () => {
    expect(scheduleFor(soon, darwin("2026-10-12 10:00"), NO_HOLIDAYS)).toMatchObject({ callThem: false, timed: true, urgent: false });
  });
});

describe("routine: 2 to 8 weeks, reminded a week before", () => {
  const weeks = (n: number): TierRequest => ({ routineWeeks: n, tier: "routine" });

  it("two weeks from a Monday: due the Monday after next, reminded a week before it", () => {
    expect(ask(weeks(2), "2026-10-12 10:00")).toEqual({
      escalateAt: "2026-10-26 16:30",
      remindAt: ["2026-10-19 08:30"],
      respondBy: "2026-10-26 16:30",
    });
  });

  it("eight weeks from a Monday", () => {
    expect(ask(weeks(8), "2026-10-12 10:00")).toEqual({
      escalateAt: "2026-12-07 16:30",
      remindAt: ["2026-11-30 08:30"],
      respondBy: "2026-12-07 16:30",
    });
  });

  it.each([2, 3, 4, 5, 6, 7, 8])("%i weeks lands on the same weekday, a week apart from its reminder", (n) => {
    const schedule = scheduleFor(weeks(n), darwin("2026-10-14 10:00"), NO_HOLIDAYS);
    expect(schedule.routineWeeks).toBe(n);
    expect(schedule.dueDate).toBe(darwinDateKey(new Date(darwin("2026-10-14 10:00").getTime() + n * 7 * 86_400_000)));
    expect(schedule.remindAt).toHaveLength(1);
    expect(schedule.respondBy!.getTime() - schedule.remindAt[0].getTime()).toBe(7 * 86_400_000 + 8 * 3_600_000);
  });

  it("from a Saturday, the date moves to the Monday and the reminder to a week before that", () => {
    expect(ask(weeks(2), "2026-10-17 10:00")).toEqual({
      escalateAt: "2026-11-02 16:30",
      remindAt: ["2026-10-26 08:30"],
      respondBy: "2026-11-02 16:30",
    });
  });

  it("moves a deadline off a public holiday, and the reminder to the business day before its week-earlier date", () => {
    expect(ask(weeks(2), "2026-10-12 10:00", holidays("2026-10-26"))).toEqual({
      escalateAt: "2026-10-27 16:30",
      remindAt: ["2026-10-20 08:30"],
      respondBy: "2026-10-27 16:30",
    });
    expect(ask(weeks(2), "2026-10-12 10:00", holidays("2026-10-19"))).toEqual({
      escalateAt: "2026-10-26 16:30",
      remindAt: ["2026-10-16 08:30"],
      respondBy: "2026-10-26 16:30",
    });
  });

  it.each([0, 1, 9, 2.5, Number.NaN, "3", null, undefined])("refuses %p weeks", (value) => {
    expect(() => scheduleFor({ routineWeeks: value as never, tier: "routine" }, darwin("2026-10-12 10:00"), NO_HOLIDAYS)).toThrow(TierError);
  });
});

describe("fixed: the date given, reminded 4, 2 and 1 days before and on the day", () => {
  const on = (fixedDate: string): TierRequest => ({ fixedDate, tier: "fixed" });

  it("a Friday: Monday, Wednesday and Thursday before, and the day itself; moved up at its close", () => {
    expect(ask(on("2026-10-23"), "2026-10-12 10:00")).toEqual({
      escalateAt: "2026-10-23 16:30",
      remindAt: ["2026-10-19 08:30", "2026-10-21 08:30", "2026-10-22 08:30", "2026-10-23 08:30"],
      respondBy: "2026-10-23 16:30",
    });
  });

  it("a Monday: the weekend's two reminders collapse into the Friday before", () => {
    expect(ask(on("2026-10-26"), "2026-10-12 10:00")).toEqual({
      escalateAt: "2026-10-26 16:30",
      remindAt: ["2026-10-22 08:30", "2026-10-23 08:30", "2026-10-26 08:30"],
      respondBy: "2026-10-26 16:30",
    });
  });

  it("a Tuesday: four days before is the Friday, two the Sunday that becomes it, one the Monday", () => {
    expect(ask(on("2026-10-27"), "2026-10-12 10:00").remindAt).toEqual([
      "2026-10-23 08:30",
      "2026-10-26 08:30",
      "2026-10-27 08:30",
    ]);
  });

  it("drops a reminder already in the past, keeping the rest", () => {
    expect(ask(on("2026-10-13"), "2026-10-12 10:00")).toEqual({
      escalateAt: "2026-10-13 16:30",
      remindAt: ["2026-10-13 08:30"],
      respondBy: "2026-10-13 16:30",
    });
    expect(ask(on("2026-10-16"), "2026-10-14 09:00").remindAt).toEqual(["2026-10-15 08:30", "2026-10-16 08:30"]);
  });

  it("keeps the reminder for the morning of today when it is asked before it", () => {
    expect(ask(on("2026-10-12"), "2026-10-12 07:00").remindAt).toEqual(["2026-10-12 08:30"]);
  });

  it("asked on the day itself during business hours: due at close, no reminders left", () => {
    expect(ask(on("2026-10-12"), "2026-10-12 10:00")).toEqual({
      escalateAt: "2026-10-12 16:30",
      remindAt: [],
      respondBy: "2026-10-12 16:30",
    });
    expect(ask(on("2026-10-12"), "2026-10-12 16:29").respondBy).toBe("2026-10-12 16:30");
  });

  it("moves a reminder that falls on a public holiday to the business day before", () => {
    expect(ask(on("2026-10-23"), "2026-10-12 10:00", holidays("2026-10-21"))).toMatchObject({
      remindAt: ["2026-10-19 08:30", "2026-10-20 08:30", "2026-10-22 08:30", "2026-10-23 08:30"],
    });
  });

  it("refuses a working day that has passed, close of business or later today included", () => {
    for (const [date, start] of [
      ["2026-10-09", "2026-10-12 10:00"],
      ["2026-10-08", "2026-10-12 10:00"],
      ["2026-10-12", "2026-10-12 16:30"],
      ["2026-10-12", "2026-10-12 21:00"],
    ]) {
      expect(() => scheduleFor(on(date), darwin(start), NO_HOLIDAYS)).toThrow(expect.objectContaining({ code: "fixed_date_past", status: 422 }));
    }
  });

  it("refuses a weekend date and a public holiday, which are not working days", () => {
    for (const date of ["2026-10-17", "2026-10-18"]) {
      expect(() => scheduleFor(on(date), darwin("2026-10-12 10:00"), NO_HOLIDAYS)).toThrow(
        expect.objectContaining({ code: "fixed_date_not_a_working_day", status: 422 }),
      );
    }
    expect(() => scheduleFor(on("2026-10-19"), darwin("2026-10-12 10:00"), holidays("2026-10-19"))).toThrow(
      expect.objectContaining({ code: "fixed_date_not_a_working_day" }),
    );
  });

  it("refuses a date more than a year out", () => {
    const now = darwin("2026-10-12 10:00");
    expect(() => scheduleFor(on("2028-01-03"), now, NO_HOLIDAYS)).toThrow(expect.objectContaining({ code: "fixed_date_too_far", status: 422 }));
    expect(FIXED_MAX_DAYS_AHEAD).toBe(366);
    // 2027-10-12 is 365 days ahead, a Tuesday.
    expect(scheduleFor(on("2027-10-12"), now, NO_HOLIDAYS).respondBy).not.toBeNull();
  });

  it("reports the date it was given", () => {
    expect(scheduleFor(on("2026-10-23"), darwin("2026-10-12 10:00"), NO_HOLIDAYS)).toMatchObject({
      dueDate: "2026-10-23",
      fixedDate: "2026-10-23",
      routineWeeks: null,
      urgent: false,
    });
  });
});

describe("parseTierRequest", () => {
  it("reads each tier's own input", () => {
    expect(parseTierRequest({ tier: "emergency" })).toEqual({ tier: "emergency" });
    expect(parseTierRequest({ tier: "urgent" })).toEqual({ tier: "urgent" });
    expect(parseTierRequest({ tier: "soon" })).toEqual({ tier: "soon" });
    expect(parseTierRequest({ routineWeeks: 4, tier: "routine" })).toEqual({ routineWeeks: 4, tier: "routine" });
    expect(parseTierRequest({ fixedDate: "2026-10-23", tier: "fixed" })).toEqual({ fixedDate: "2026-10-23", tier: "fixed" });
  });

  describe("autoEscalate", () => {
    it("is absent for an urgent request that does not mention it, so it defaults to off", () => {
      expect(parseTierRequest({ tier: "urgent" })).toEqual({ tier: "urgent" });
      expect(parseTierRequest({ autoEscalate: null, tier: "urgent" })).toEqual({ tier: "urgent" });
      expect(parseTierRequest({ autoEscalate: undefined, tier: "urgent" })).toEqual({ tier: "urgent" });
      expect(scheduleFor(parseTierRequest({ tier: "urgent" }), darwin("2026-10-12 09:00"), NO_HOLIDAYS).escalateAt).toBeNull();
    });

    it("is read from an urgent request, true or false", () => {
      expect(parseTierRequest({ autoEscalate: true, tier: "urgent" })).toEqual({ autoEscalate: true, tier: "urgent" });
      expect(parseTierRequest({ autoEscalate: false, tier: "urgent" })).toEqual({ autoEscalate: false, tier: "urgent" });
      expect(scheduleFor(parseTierRequest({ autoEscalate: true, tier: "urgent" }), darwin("2026-10-12 09:00"), NO_HOLIDAYS).escalateAt).not.toBeNull();
      expect(scheduleFor(parseTierRequest({ autoEscalate: false, tier: "urgent" }), darwin("2026-10-12 09:00"), NO_HOLIDAYS).escalateAt).toBeNull();
    });

    it("is accepted as true on soon, routine and fixed, which always move up anyway", () => {
      expect(parseTierRequest({ autoEscalate: true, tier: "soon" })).toEqual({ tier: "soon" });
      expect(parseTierRequest({ autoEscalate: true, routineWeeks: 4, tier: "routine" })).toEqual({ routineWeeks: 4, tier: "routine" });
      expect(parseTierRequest({ autoEscalate: true, fixedDate: "2026-10-23", tier: "fixed" })).toEqual({ fixedDate: "2026-10-23", tier: "fixed" });
      expect(parseTierRequest({ autoEscalate: null, tier: "soon" })).toEqual({ tier: "soon" });
    });

    it("is refused as false on soon, routine and fixed with a 400", () => {
      for (const raw of [
        { autoEscalate: false, tier: "soon" },
        { autoEscalate: false, routineWeeks: 4, tier: "routine" },
        { autoEscalate: false, fixedDate: "2026-10-23", tier: "fixed" },
      ]) {
        expect(() => parseTierRequest(raw)).toThrow(expect.objectContaining({ code: "auto_escalate_not_optional", name: "TierError", status: 400 }));
      }
    });

    it("is ignored on an emergency, which is never chased", () => {
      expect(parseTierRequest({ autoEscalate: true, tier: "emergency" })).toEqual({ tier: "emergency" });
      expect(parseTierRequest({ autoEscalate: false, tier: "emergency" })).toEqual({ tier: "emergency" });
    });

    it.each(["yes", "true", "false", 1, 0, [], {}, [true]])("refuses %j, which is not true or false, on every tier", (autoEscalate) => {
      for (const extra of [{ tier: "emergency" }, { tier: "urgent" }, { tier: "soon" }, { routineWeeks: 3, tier: "routine" }, { fixedDate: "2026-10-23", tier: "fixed" }]) {
        expect(() => parseTierRequest({ autoEscalate, ...extra })).toThrow(expect.objectContaining({ code: "auto_escalate_invalid", status: 400 }));
      }
    });

    it("checks the tier's own input first, so the first thing wrong is what gets said", () => {
      expect(() => parseTierRequest({ autoEscalate: false, tier: "routine" })).toThrow(expect.objectContaining({ code: "routine_weeks_required" }));
      expect(() => parseTierRequest({ autoEscalate: false, tier: "fixed" })).toThrow(expect.objectContaining({ code: "fixed_date_required" }));
    });
  });

  it("lets an input a tier does not take be null or empty", () => {
    expect(parseTierRequest({ fixedDate: null, routineWeeks: null, tier: "soon" })).toEqual({ tier: "soon" });
    expect(parseTierRequest({ fixedDate: "", tier: "urgent" })).toEqual({ tier: "urgent" });
    expect(parseTierRequest({ fixedDate: "", routineWeeks: 3, tier: "routine" })).toEqual({ routineWeeks: 3, tier: "routine" });
  });

  it.each([
    [{ tier: "Urgent" }, "invalid_tier"],
    [{ tier: "" }, "invalid_tier"],
    [{}, "invalid_tier"],
    [{ tier: 3 }, "invalid_tier"],
    [{ tier: "routine" }, "routine_weeks_required"],
    [{ routineWeeks: 1, tier: "routine" }, "routine_weeks_invalid"],
    [{ routineWeeks: 9, tier: "routine" }, "routine_weeks_invalid"],
    [{ routineWeeks: "3", tier: "routine" }, "routine_weeks_invalid"],
    [{ routineWeeks: 2.5, tier: "routine" }, "routine_weeks_invalid"],
    [{ fixedDate: "2026-10-23", routineWeeks: 3, tier: "routine" }, "unexpected_fixed_date"],
    [{ tier: "fixed" }, "fixed_date_required"],
    [{ fixedDate: "", tier: "fixed" }, "fixed_date_required"],
    [{ fixedDate: "2026-02-30", tier: "fixed" }, "fixed_date_invalid"],
    [{ fixedDate: "23/10/2026", tier: "fixed" }, "fixed_date_invalid"],
    [{ fixedDate: 20261023, tier: "fixed" }, "fixed_date_invalid"],
    [{ fixedDate: "2026-10-23", routineWeeks: 3, tier: "fixed" }, "unexpected_routine_weeks"],
    [{ routineWeeks: 3, tier: "soon" }, "unexpected_routine_weeks"],
    [{ routineWeeks: 3, tier: "emergency" }, "unexpected_routine_weeks"],
    [{ fixedDate: "2026-10-23", tier: "urgent" }, "unexpected_fixed_date"],
  ])("refuses %j with %s", (raw, code) => {
    expect(() => parseTierRequest(raw)).toThrow(expect.objectContaining({ code, status: 400 }));
  });
});

describe("the default calendar", () => {
  const saved = process.env.ESCALATION_HOLIDAYS;
  afterEach(() => {
    if (saved === undefined) delete process.env.ESCALATION_HOLIDAYS;
    else process.env.ESCALATION_HOLIDAYS = saved;
  });

  it("is ESCALATION_HOLIDAYS when no calendar is passed", () => {
    process.env.ESCALATION_HOLIDAYS = "2026-10-19";
    expect(view(scheduleFor({ tier: "soon" }, darwin("2026-10-12 10:00")))).toEqual({
      escalateAt: "2026-10-20 16:30",
      remindAt: ["2026-10-16 08:30"],
      respondBy: "2026-10-20 16:30",
    });
    delete process.env.ESCALATION_HOLIDAYS;
    expect(view(scheduleFor({ tier: "soon" }, darwin("2026-10-12 10:00"))).respondBy).toBe("2026-10-19 16:30");
  });
});

describe("whenever it is asked", () => {
  const CALENDAR = holidays("2026-10-19", "2026-11-03", "2026-12-25", "2026-12-28");
  const TIMED: DecisionTier[] = ["urgent", "soon", "routine", "fixed"];

  function requestFor(tier: DecisionTier, now: Date): TierRequest {
    if (tier === "routine") return { routineWeeks: 2 + (Math.floor(now.getTime() / 86_400_000) % 7), tier };
    // The first business day at least three days out.
    if (tier === "fixed") return { fixedDate: nextBusinessDay(addCalendarDays(darwinDateKey(now), 3), CALENDAR), tier };
    // An urgent request only moves up when ticked; the unticked one is below.
    if (tier === "urgent") return { autoEscalate: true, tier };
    return { tier };
  }

  // Every 37 minutes across five weeks: all days of the week, every hour, the
  // holidays above and the two ends of every business day.
  const starts: Date[] = [];
  for (let t = darwin("2026-10-10 00:00").getTime(); t < darwin("2026-11-14 00:00").getTime(); t += 37 * 60_000) starts.push(new Date(t));

  it.each(TIMED)("%s is always ordered, in the future and inside business hours", (tier) => {
    for (const now of starts) {
      const request = requestFor(tier, now);
      const s = scheduleFor(request, now, CALENDAR);
      const label = `${tier} asked ${show(now)}: ${JSON.stringify(view(s))}`;

      expect(s.timed).toBe(true);
      expect({ label, ok: s.respondBy!.getTime() > now.getTime() }).toEqual({ label, ok: true });
      // the deadline is close of business on a business day
      expect({ label, ok: isBusinessDay(darwinDateKey(s.respondBy!), CALENDAR) && darwinMinuteOfDay(s.respondBy!) === 16 * 60 + 30 }).toEqual({ label, ok: true });
      // nobody is moved up before the deadline
      expect({ label, ok: s.escalateAt!.getTime() >= s.respondBy!.getTime() }).toEqual({ label, ok: true });
      // reminders: ascending, distinct, ahead of now, before the deadline, in business hours on business days
      const times = s.remindAt.map((r) => r.getTime());
      expect({ label, ok: times.every((time, i) => time > now.getTime() && time < s.respondBy!.getTime() && (i === 0 || time > times[i - 1])) }).toEqual({ label, ok: true });
      for (const r of s.remindAt) {
        const minute = darwinMinuteOfDay(r);
        expect({ label, ok: isBusinessDay(darwinDateKey(r), CALENDAR) && minute >= 510 && minute < 990 }).toEqual({ label, ok: true });
      }
      // the move-up is also inside business hours, or at close of business itself
      const escMinute = darwinMinuteOfDay(s.escalateAt!);
      expect({ label, ok: isBusinessDay(darwinDateKey(s.escalateAt!), CALENDAR) && escMinute >= 510 && escMinute <= 990 }).toEqual({ label, ok: true });
    }
  });

  it("urgent not ticked is the ticked one with nothing to move up, whenever it is asked", () => {
    for (const now of starts) {
      const ticked = scheduleFor({ autoEscalate: true, tier: "urgent" }, now, CALENDAR);
      const unticked = scheduleFor({ tier: "urgent" }, now, CALENDAR);
      const label = `urgent asked ${show(now)}`;

      expect({ label, ok: unticked.escalateAt === null && unticked.autoEscalate === false }).toEqual({ label, ok: true });
      expect({ label, ok: ticked.escalateAt !== null && ticked.autoEscalate === true }).toEqual({ label, ok: true });
      expect({ label, schedule: { ...unticked, autoEscalate: true, escalateAt: ticked.escalateAt } }).toEqual({ label, schedule: ticked });
      // the reminder is still there
      expect({ label, reminders: unticked.remindAt.length }).toEqual({ label, reminders: 1 });
    }
  });

  it("emergency never has anything to chase", () => {
    for (const now of starts) {
      expect(scheduleFor({ tier: "emergency" }, now, CALENDAR)).toMatchObject({ escalateAt: null, remindAt: [], respondBy: null });
    }
  });

  it("every tier lists the reminders the table says", () => {
    const now = darwin("2026-10-12 06:00");
    const requests: Record<string, TierRequest> = {
      fixed: { fixedDate: "2026-10-23", tier: "fixed" },
      routine: { routineWeeks: 3, tier: "routine" },
      soon: { tier: "soon" },
      urgent: { tier: "urgent" },
    };
    const counts = Object.fromEntries(Object.entries(requests).map(([tier, request]) => [tier, scheduleFor(request, now, NO_HOLIDAYS).remindAt.length]));
    expect(counts).toEqual({ fixed: 4, routine: 1, soon: 1, urgent: 1 });
    expect(DECISION_TIERS).toEqual(["emergency", "urgent", "soon", "routine", "fixed"]);
  });
});
