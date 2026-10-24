/// <reference types="jest" />
import { NO_HOLIDAYS } from "../escalation/businessTime";
import { DIRECTORY, TODAY } from "../__tests__/fixtures/absenceCover";
import { detectAbsences, displayDate, quietBusinessDays, returnDateAfter, type DetectInput, type LeaveFact } from "./absence";

const leave = (over: Partial<LeaveFact> = {}): LeaveFact => ({
  approvedOn: "2026-10-01",
  endDate: "2026-10-30",
  kind: "annual_leave",
  requestId: 11,
  startDate: "2026-10-26",
  userId: 1,
  ...over,
});

const detect = (over: Partial<DetectInput> = {}) =>
  detectAbsences({
    accessLoggingOn: true,
    holidays: NO_HOLIDAYS,
    inactivityDays: 3,
    lastSeenOn: new Map(),
    leaves: [],
    staff: DIRECTORY,
    today: TODAY,
    ...over,
  });

describe("returnDateAfter: the first business day after the leave ends", () => {
  it.each([
    ["a Friday end goes over the weekend to Monday", "2026-10-30", "2026-11-02"],
    ["a Monday end returns Tuesday", "2026-10-26", "2026-10-27"],
    ["a Saturday end returns Monday", "2026-10-31", "2026-11-02"],
    ["the last day of a month returns on the first business day of the next", "2026-09-30", "2026-10-01"],
    ["a month end on a Friday returns on the Monday", "2026-07-31", "2026-08-03"],
    ["the last day of the year returns on the next business day", "2026-12-31", "2027-01-01"],
  ])("%s", (_label, end, back) => {
    expect(returnDateAfter(end, NO_HOLIDAYS)).toBe(back);
  });

  it("skips configured public holidays, and weekends only when none are", () => {
    const holidays = new Set(["2026-11-02"]);
    expect(returnDateAfter("2026-10-30", holidays)).toBe("2026-11-03");
    expect(returnDateAfter("2026-10-30", NO_HOLIDAYS)).toBe("2026-11-02");
  });
});

describe("detectAbsences: leave", () => {
  it("is planned when the leave was approved before it started", () => {
    const { absent } = detect({ leaves: [leave()] });
    expect(absent).toHaveLength(1);
    expect(absent[0]).toMatchObject({ kind: "planned", reasonCode: "planned_leave", ref: "leave:11", returnDate: "2026-11-02", userId: 1 });
    expect(absent[0].reason).toBe("On annual leave until 30/10/2026");
  });

  it("is unplanned when sick or personal leave was booked on the day it starts", () => {
    const { absent } = detect({ leaves: [leave({ approvedOn: "2026-10-26", kind: "personal_leave", endDate: "2026-10-27" })] });
    expect(absent[0]).toMatchObject({ kind: "unplanned", reasonCode: "unplanned_leave", returnDate: "2026-10-28" });
    expect(absent[0].reason).toContain("not planned");
  });

  it("is unplanned when leave started earlier and was only approved after it began", () => {
    expect(detect({ leaves: [leave({ approvedOn: "2026-10-27", startDate: "2026-10-26" })] }).absent[0].kind).toBe("unplanned");
  });

  it("is planned when approved the day before the start", () => {
    expect(detect({ leaves: [leave({ approvedOn: "2026-10-25" })] }).absent[0].kind).toBe("planned");
  });

  it("ignores leave that has not started and leave that has ended", () => {
    expect(detect({ leaves: [leave({ startDate: "2026-10-27" }), leave({ endDate: "2026-10-23", requestId: 12, startDate: "2026-10-19" })] }).absent).toEqual([]);
  });

  it("treats the first and the last day of the leave as away", () => {
    expect(detect({ leaves: [leave({ endDate: "2026-10-26" })] }).absent).toHaveLength(1);
    expect(detect({ leaves: [leave({ startDate: "2026-10-20", endDate: "2026-10-26" })] }).absent).toHaveLength(1);
  });

  it("runs back-to-back leave on, so the return is after the last of the run", () => {
    const { absent } = detect({ leaves: [leave(), leave({ endDate: "2026-11-06", requestId: 12, startDate: "2026-11-02" })] });
    expect(absent[0].endDate).toBe("2026-11-06");
    expect(absent[0].returnDate).toBe("2026-11-09");
  });

  it("does not run on through leave that starts after a gap of a business day", () => {
    const { absent } = detect({ leaves: [leave(), leave({ endDate: "2026-11-06", requestId: 12, startDate: "2026-11-03" })] });
    expect(absent[0].returnDate).toBe("2026-11-02");
  });

  it("describes sick and other leave in plain words", () => {
    expect(detect({ leaves: [leave({ kind: "unpaid_leave" })] }).absent[0].reason).toContain("unpaid leave");
    expect(detect({ leaves: [leave({ kind: "something_else" })] }).absent[0].reason).toContain("On leave until");
  });
});

describe("detectAbsences: no sign-in", () => {
  it("counts only business days that finished with no sign-in", () => {
    expect(quietBusinessDays("2026-10-23", "2026-10-28", NO_HOLIDAYS)).toBe(2); // Fri seen: Mon and Tue finished, Wed is today
    expect(quietBusinessDays("2026-10-23", "2026-10-29", NO_HOLIDAYS)).toBe(3);
    expect(quietBusinessDays("2026-10-26", "2026-10-26", NO_HOLIDAYS)).toBe(0);
    expect(quietBusinessDays("2026-10-22", "2026-10-26", NO_HOLIDAYS)).toBe(1); // Thu seen: Fri finished, the weekend is skipped
  });

  it("does not count holidays", () => {
    expect(quietBusinessDays("2026-10-23", "2026-10-29", new Set(["2026-10-27"]))).toBe(2);
  });

  it("calls someone inactive after the set number of quiet business days, with the reason", () => {
    const { absent } = detect({ lastSeenOn: new Map([[7, "2026-10-20"]]) });
    expect(absent).toHaveLength(1);
    expect(absent[0]).toMatchObject({ endDate: null, kind: "inactive", quietBusinessDays: 3, reasonCode: "no_sign_in", ref: "inactive:2026-10-20", returnDate: null, userId: 7 });
    expect(absent[0].reason).toBe("Has not signed in since 20/10/2026 (3 business days)");
  });

  it("does not call them inactive one day short, or with a longer setting", () => {
    expect(detect({ lastSeenOn: new Map([[7, "2026-10-21"]]) }).absent).toEqual([]);
    expect(detect({ inactivityDays: 5, lastSeenOn: new Map([[7, "2026-10-20"]]) }).absent).toEqual([]);
  });

  it("is unavailable when access logging is off: nobody is called inactive", () => {
    const result = detect({ accessLoggingOn: false, lastSeenOn: new Map([[7, "2026-10-01"]]) });
    expect(result.absent).toEqual([]);
    expect(result.inactivityAvailable).toBe(false);
    expect(detect().inactivityAvailable).toBe(true);
  });

  it("never calls away someone the log has not seen at all", () => {
    expect(detect({ lastSeenOn: new Map() }).absent).toEqual([]);
  });

  it("does not call someone on leave inactive, and leave wins over a quiet log", () => {
    const { absent } = detect({ lastSeenOn: new Map([[1, "2026-10-01"]]), leaves: [leave()] });
    expect(absent).toHaveLength(1);
    expect(absent[0].kind).toBe("planned");
  });
});

it("lists people by name", () => {
  const { absent } = detect({ lastSeenOn: new Map([[7, "2026-10-01"], [3, "2026-10-01"]]), leaves: [leave()] });
  expect(absent.map((person) => person.name)).toEqual(["Ann Accounts", "Fay Facilities", "Sam Facilities"]);
});

it("writes dates as DD/MM/YYYY", () => {
  expect(displayDate("2026-11-02")).toBe("02/11/2026");
});
