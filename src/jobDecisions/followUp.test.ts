/// <reference types="jest" />
// How long what follows a decision is given (jobs plan A2): the next step it hands
// on, and a deferred question coming back. Pure.
import { NO_HOLIDAYS, type Holidays } from "../escalation/businessTime";
import { followUpSchedule, followUpTier } from "./followUp";
import type { DecisionRequestRow } from "./store";

// Monday 2026-10-12, 09:00 Darwin
const NOW = new Date(Date.UTC(2026, 9, 12, 9, 0) - 9.5 * 3_600_000);
const darwin = (date: string, hhmm: string): Date => {
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d, h, min) - 9.5 * 3_600_000);
};

type Req = Pick<DecisionRequestRow, "autoEscalate" | "respondBy" | "routineWeeks" | "tier">;
const request = (over: Partial<Req>): Req => ({ autoEscalate: true, respondBy: null, routineWeeks: null, tier: "soon", ...over });

describe("followUpTier", () => {
  it("soon stays soon, for a step and for a question coming back", () => {
    for (const purpose of ["next_step", "reask"] as const) {
      expect(followUpTier(request({ tier: "soon" }), purpose, NOW, NO_HOLIDAYS)).toEqual({ tier: "soon" });
    }
  });

  it("routine keeps its weeks", () => {
    expect(followUpTier(request({ routineWeeks: 5, tier: "routine" }), "next_step", NOW, NO_HOLIDAYS)).toEqual({ routineWeeks: 5, tier: "routine" });
    expect(followUpTier(request({ routineWeeks: 2, tier: "routine" }), "reask", NOW, NO_HOLIDAYS)).toEqual({ routineWeeks: 2, tier: "routine" });
  });

  it("routine with no weeks recorded falls back to soon rather than inventing a number", () => {
    expect(followUpTier(request({ routineWeeks: null, tier: "routine" }), "next_step", NOW, NO_HOLIDAYS)).toEqual({ tier: "soon" });
  });

  describe("urgent", () => {
    it("a next step always moves up, whatever the asker ticked", () => {
      for (const autoEscalate of [true, false]) {
        expect(followUpTier(request({ autoEscalate, tier: "urgent" }), "next_step", NOW, NO_HOLIDAYS)).toEqual({ autoEscalate: true, tier: "urgent" });
      }
    });

    it("a question coming back keeps the asker's tick, or its absence", () => {
      expect(followUpTier(request({ autoEscalate: true, tier: "urgent" }), "reask", NOW, NO_HOLIDAYS)).toEqual({ autoEscalate: true, tier: "urgent" });
      expect(followUpTier(request({ autoEscalate: false, tier: "urgent" }), "reask", NOW, NO_HOLIDAYS)).toEqual({ autoEscalate: false, tier: "urgent" });
    });
  });

  describe("fixed", () => {
    it("keeps the date while it is still a working day to come (close of business that day)", () => {
      const respondBy = darwin("2026-10-23", "16:30");
      expect(followUpTier(request({ respondBy, tier: "fixed" }), "next_step", NOW, NO_HOLIDAYS)).toEqual({ fixedDate: "2026-10-23", tier: "fixed" });
      expect(followUpTier(request({ respondBy, tier: "fixed" }), "reask", NOW, NO_HOLIDAYS)).toEqual({ fixedDate: "2026-10-23", tier: "fixed" });
    });

    it("keeps today's date until the working day has closed", () => {
      const respondBy = darwin("2026-10-12", "16:30");
      expect(followUpTier(request({ respondBy, tier: "fixed" }), "next_step", NOW, NO_HOLIDAYS)).toEqual({ fixedDate: "2026-10-12", tier: "fixed" });
      const evening = darwin("2026-10-12", "17:30");
      expect(followUpTier(request({ respondBy, tier: "fixed" }), "next_step", evening, NO_HOLIDAYS)).toEqual({ autoEscalate: true, tier: "urgent" });
    });

    it("becomes urgent, moving up, when the date has gone", () => {
      const respondBy = darwin("2026-10-08", "16:30");
      for (const purpose of ["next_step", "reask"] as const) {
        expect(followUpTier(request({ respondBy, tier: "fixed" }), purpose, NOW, NO_HOLIDAYS)).toEqual({ autoEscalate: true, tier: "urgent" });
      }
    });

    it("becomes urgent when the date is a holiday that has since been declared", () => {
      const respondBy = darwin("2026-10-23", "16:30");
      const holidays: Holidays = new Set(["2026-10-23"]);
      expect(followUpTier(request({ respondBy, tier: "fixed" }), "next_step", NOW, holidays)).toEqual({ autoEscalate: true, tier: "urgent" });
    });

    it("becomes urgent when no date was recorded", () => {
      expect(followUpTier(request({ respondBy: null, tier: "fixed" }), "next_step", NOW, NO_HOLIDAYS)).toEqual({ autoEscalate: true, tier: "urgent" });
    });
  });

  it("an emergency is never chased, but what follows it is ordinary work: urgent, and moving up", () => {
    for (const purpose of ["next_step", "reask"] as const) {
      expect(followUpTier(request({ autoEscalate: false, tier: "emergency" }), purpose, NOW, NO_HOLIDAYS)).toEqual({ autoEscalate: true, tier: "urgent" });
    }
  });
});

describe("followUpSchedule: when it is due, reminded and moved up", () => {
  it("a soon step is due a week on, reminded the working day before, and moves up at close of business", () => {
    const schedule = followUpSchedule(request({ tier: "soon" }), "next_step", NOW, NO_HOLIDAYS);
    expect(schedule).toMatchObject({ autoEscalate: true, dueDate: "2026-10-19", tier: "soon", urgent: false });
    expect(schedule.respondBy).toEqual(darwin("2026-10-19", "16:30"));
    expect(schedule.escalateAt).toEqual(darwin("2026-10-19", "16:30"));
    expect(schedule.remindAt).toEqual([darwin("2026-10-16", "08:30")]);
  });

  it("an urgent step is due by tomorrow, is urgent, and always has a time it moves up", () => {
    const schedule = followUpSchedule(request({ autoEscalate: false, tier: "urgent" }), "next_step", NOW, NO_HOLIDAYS);
    expect(schedule).toMatchObject({ autoEscalate: true, dueDate: "2026-10-13", tier: "urgent", urgent: true });
    expect(schedule.respondBy).toEqual(darwin("2026-10-13", "16:30"));
    expect(schedule.escalateAt).not.toBeNull();
    expect(schedule.escalateAt?.getTime()).toBeGreaterThan(darwin("2026-10-13", "16:30").getTime());
  });

  it("a question coming back from an unticked urgent request is still not moved up", () => {
    const schedule = followUpSchedule(request({ autoEscalate: false, tier: "urgent" }), "reask", NOW, NO_HOLIDAYS);
    expect(schedule).toMatchObject({ autoEscalate: false, escalateAt: null, tier: "urgent" });
    expect(schedule.respondBy).toEqual(darwin("2026-10-13", "16:30"));
  });

  it("is counted from the day it begins: the same request a month later is due a month later", () => {
    const later = new Date(NOW.getTime() + 28 * 86_400_000);
    expect(followUpSchedule(request({ tier: "soon" }), "next_step", later, NO_HOLIDAYS).dueDate).toBe("2026-11-16");
  });

  it("a routine step is due the same number of weeks on, reminded a week before", () => {
    const schedule = followUpSchedule(request({ routineWeeks: 3, tier: "routine" }), "next_step", NOW, NO_HOLIDAYS);
    expect(schedule).toMatchObject({ dueDate: "2026-11-02", routineWeeks: 3, tier: "routine" });
    expect(schedule.remindAt).toEqual([darwin("2026-10-26", "08:30")]);
  });

  it("a fixed step is due on the same day, with the same reminders still to come", () => {
    const respondBy = darwin("2026-10-23", "16:30");
    const schedule = followUpSchedule(request({ respondBy, tier: "fixed" }), "next_step", NOW, NO_HOLIDAYS);
    expect(schedule).toMatchObject({ dueDate: "2026-10-23", fixedDate: "2026-10-23", tier: "fixed" });
    expect(schedule.remindAt.length).toBeGreaterThan(0);
  });

  it("never throws for any request tier, at any hour: the follow-up of a request is always a schedule", () => {
    const tiers = ["emergency", "urgent", "soon", "routine", "fixed"] as const;
    for (const tier of tiers) {
      for (const hours of [0, 5, 12, 30, 50, 24 * 40]) {
        const now = new Date(NOW.getTime() + hours * 3_600_000);
        const over = { respondBy: darwin("2026-10-14", "16:30"), routineWeeks: tier === "routine" ? 4 : null, tier };
        for (const purpose of ["next_step", "reask"] as const) {
          expect(() => followUpSchedule(request(over), purpose, now, NO_HOLIDAYS)).not.toThrow();
        }
      }
    }
  });
});
