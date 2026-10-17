/// <reference types="jest" />
// The lease-events feed: which rows there are, when they are overdue, and the
// order they come in. Pure; every date is relative to a `today` passed in.
import { addDaysIso, addMonthsClamped } from "../darwinDate";
import {
  buildLeaseEvents,
  DEFAULT_LEASE_EVENT_DAYS,
  MAX_LEASE_EVENT_DAYS,
  type LeaseEventReview,
  type LeaseEventTenancy,
} from "../rentReview/leaseEvents";

const TODAY = "2026-10-14";
const DAY = (offset: number): string => addDaysIso(TODAY, offset);

const tenancy = (id: number, over: Partial<LeaseEventTenancy> = {}): LeaseEventTenancy => ({
  buildingId: 5,
  expiry: null,
  optionNoticeMonths: null,
  optionPeriods: null,
  scheduleSignedOff: true,
  tenantId: id,
  tenantName: `Tenant ${id}`,
  ...over,
});

const review = (id: number, scheduledFor: string, over: Partial<LeaseEventReview> = {}): LeaseEventReview => ({
  buildingId: 5,
  method: "cpi",
  ownerName: null,
  ownerUserId: null,
  reviewId: `rev-${id}`,
  scheduleSignedOff: true,
  scheduledFor,
  state: "due",
  tenantId: id,
  tenantName: `Tenant ${id}`,
  ...over,
});

const build = (tenancies: LeaseEventTenancy[], reviews: LeaseEventReview[], days = 90) =>
  buildLeaseEvents({ days, reviews, tenancies, today: TODAY });

describe("defaults", () => {
  it("looks 90 days ahead, at most a year", () => {
    expect(DEFAULT_LEASE_EVENT_DAYS).toBe(90);
    expect(MAX_LEASE_EVENT_DAYS).toBe(365);
  });
});

describe("review rows", () => {
  it("lists an open review inside the window, with its state, owner and method", () => {
    const [event] = build([], [review(1, DAY(30), { ownerName: "Ann", ownerUserId: 7, state: "in_progress" })]);
    expect(event).toEqual({
      buildingId: 5,
      date: DAY(30),
      kind: "review",
      method: "cpi",
      overdue: false,
      ownerName: "Ann",
      ownerUserId: 7,
      reviewId: "rev-1",
      scheduleSignedOff: true,
      state: "in_progress",
      tenantId: 1,
      tenantName: "Tenant 1",
    });
  });

  it("includes the last day of the window and leaves out the day after", () => {
    expect(build([], [review(1, DAY(90)), review(2, DAY(91))]).map((e) => e.tenantId)).toEqual([1]);
    expect(build([], [review(1, DAY(30)), review(2, DAY(31))], 30).map((e) => e.tenantId)).toEqual([1]);
  });

  it("keeps an open review whose date has passed, as overdue, however long ago", () => {
    const events = build([], [review(1, DAY(-1)), review(2, DAY(-800), { state: "awaiting_approval" })]);
    expect(events.map((e) => [e.tenantId, e.overdue])).toEqual([
      [2, true],
      [1, true],
    ]);
  });

  it("is not overdue on its own day", () => {
    expect(build([], [review(1, TODAY)])[0].overdue).toBe(false);
  });

  it("is overdue in every open state", () => {
    for (const state of ["scheduled", "due", "in_progress", "awaiting_index", "referred", "awaiting_approval"] as const) {
      expect(build([], [review(1, DAY(-5), { state })])[0].overdue).toBe(true);
    }
  });

  it("leaves out a review with no date", () => {
    expect(build([], [review(1, "")])).toEqual([]);
  });
});

describe("expiry rows: every active tenancy, not only those with a review due (F18c)", () => {
  it("lists a tenancy expiring inside the window though it has no review at all", () => {
    const events = build([tenancy(1, { expiry: DAY(45) })], []);
    expect(events).toEqual([
      { buildingId: 5, date: DAY(45), kind: "expiry", overdue: false, scheduleSignedOff: true, tenantId: 1, tenantName: "Tenant 1" },
    ]);
  });

  it("includes the last day of the window and leaves out the day after", () => {
    expect(build([tenancy(1, { expiry: DAY(90) }), tenancy(2, { expiry: DAY(91) })], []).map((e) => e.tenantId)).toEqual([1]);
  });

  it("lists an expiry that has already passed, as overdue: the tenancy is still active", () => {
    const [event] = build([tenancy(1, { expiry: DAY(-10) })], []);
    expect(event).toMatchObject({ kind: "expiry", overdue: true, date: DAY(-10) });
  });

  it("is not overdue on the expiry day itself", () => {
    expect(build([tenancy(1, { expiry: TODAY })], [])[0].overdue).toBe(false);
  });

  it("leaves out a tenancy with no expiry or one further out", () => {
    expect(build([tenancy(1), tenancy(2, { expiry: addMonthsClamped(TODAY, 18) })], [])).toEqual([]);
  });

  it("lists the expiry as well as the review when a tenancy has both", () => {
    const events = build([tenancy(1, { expiry: DAY(40) })], [review(1, DAY(20))]);
    expect(events.map((e) => e.kind)).toEqual(["review", "expiry"]);
  });
});

describe("option deadline rows", () => {
  // Expiry in 8 months with 6 months' notice: the deadline is 2 months out.
  const expiry = addMonthsClamped(TODAY, 8);
  const optioned = (over: Partial<LeaseEventTenancy> = {}) =>
    tenancy(1, { expiry, optionNoticeMonths: 6, optionPeriods: "2 x 5 years", ...over });

  it("lists the last day to give notice, for an option the text lets us date", () => {
    const events = build([optioned()], [], 90);
    expect(events).toEqual([
      { buildingId: 5, date: addMonthsClamped(TODAY, 2), kind: "option_deadline", overdue: false, scheduleSignedOff: true, tenantId: 1, tenantName: "Tenant 1" },
    ]);
  });

  it("leaves it out until the deadline is inside the window", () => {
    expect(build([optioned()], [], 30)).toEqual([]);
  });

  it("leaves out a deadline that has passed", () => {
    const closed = tenancy(1, { expiry: DAY(100), optionNoticeMonths: 6, optionPeriods: "1 x 5 years" });
    expect(build([closed], [])).toEqual([]);
  });

  it("leaves out an option it can't read, or one with no notice period", () => {
    expect(build([optioned({ optionPeriods: "Nil" })], [])).toEqual([]);
    expect(build([optioned({ optionPeriods: "see lease" })], [])).toEqual([]);
    expect(build([optioned({ optionNoticeMonths: null })], [])).toEqual([]);
    expect(build([optioned({ optionNoticeMonths: 0 })], [])).toEqual([]);
  });

  it("is month-end safe: 31 Aug less 6 months is the last day of February", () => {
    const events = buildLeaseEvents({
      days: 400,
      reviews: [],
      tenancies: [tenancy(1, { expiry: "2027-08-31", optionNoticeMonths: 6, optionPeriods: "1 x 5 years" })],
      today: "2026-10-14",
    });
    expect(events.find((e) => e.kind === "option_deadline")?.date).toBe("2027-02-28");
  });
});

describe("order", () => {
  it("puts overdue rows first, oldest first, then the rest by date", () => {
    const events = build(
      [tenancy(10, { expiry: DAY(15) }), tenancy(11, { expiry: DAY(-4) })],
      [review(1, DAY(60)), review(2, DAY(-30)), review(3, DAY(5))],
    );
    expect(events.map((e) => `${e.kind}:${e.tenantId}:${e.overdue}`)).toEqual([
      "review:2:true",
      "expiry:11:true",
      "review:3:false",
      "expiry:10:false",
      "review:1:false",
    ]);
  });

  it("breaks a tie on the date by kind (review, expiry, option deadline), then by name", () => {
    const events = build(
      [tenancy(2, { expiry: DAY(20), tenantName: "Beta" }), tenancy(3, { expiry: DAY(20), tenantName: "Alpha" })],
      [review(1, DAY(20), { tenantName: "Zed" })],
    );
    expect(events.map((e) => e.tenantName)).toEqual(["Zed", "Alpha", "Beta"]);
  });
});

describe("what the rows hold", () => {
  it("is names, ids and dates, and nothing else", () => {
    const events = build(
      [
        // The tenancies this is given carry only what the endpoint selects, but be sure nothing extra leaks if more is passed.
        { ...tenancy(1, { expiry: DAY(30), optionNoticeMonths: 6, optionPeriods: "1 x 5 years" }), rentPerAnnum: 100000, abn: "12 345", accountsEmail: "a@b.c" } as LeaseEventTenancy,
      ],
      [review(2, DAY(10))],
    );
    const allowed = new Set([
      "buildingId", "date", "kind", "method", "overdue", "ownerName", "ownerUserId", "reviewId", "scheduleSignedOff", "state", "tenantId", "tenantName",
    ]);
    expect(events.length).toBeGreaterThan(1);
    for (const event of events) {
      for (const key of Object.keys(event)) expect(allowed.has(key)).toBe(true);
    }
    expect(JSON.stringify(events)).not.toMatch(/100000|12 345|a@b\.c/);
  });
});

describe("whether the schedule behind a row is signed off (PLAN D7)", () => {
  it("is carried on every kind of row, so the dashboard can hold back an unverified schedule", () => {
    const events = build(
      [
        tenancy(1, { expiry: DAY(30), optionNoticeMonths: 6, optionPeriods: "1 x 5 years", scheduleSignedOff: false }),
        tenancy(2, { expiry: DAY(31), optionNoticeMonths: 6, optionPeriods: "1 x 5 years", scheduleSignedOff: true }),
      ],
      [review(3, DAY(10), { scheduleSignedOff: false }), review(4, DAY(11), { scheduleSignedOff: true })],
    );
    const byKey = Object.fromEntries(events.map((event) => [`${event.kind}:${event.tenantId}`, event.scheduleSignedOff]));
    expect(byKey).toMatchObject({ "expiry:1": false, "expiry:2": true, "review:3": false, "review:4": true });
  });

  it("is on the option deadline row too, when the option text can be read", () => {
    const [option] = build([tenancy(1, { expiry: addMonthsClamped(TODAY, 8), optionNoticeMonths: 6, optionPeriods: "2 x 5 years", scheduleSignedOff: false })], []);
    expect(option).toMatchObject({ kind: "option_deadline", scheduleSignedOff: false });
  });
});
