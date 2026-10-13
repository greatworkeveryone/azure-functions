/// <reference types="jest" />
import {
  darwinDayStartUtc,
  darwinFileDate,
  darwinNextDayStartUtc,
  formatDarwinDateTime,
  parseDarwinDate,
} from "./darwinTime";

const day = (value: string) => {
  const parsed = parseDarwinDate(value);
  if (!parsed) throw new Error(`test date ${value} did not parse`);
  return parsed;
};

describe("parseDarwinDate", () => {
  it("accepts real calendar dates in YYYY-MM-DD", () => {
    expect(parseDarwinDate("2026-10-13")).toEqual({ day: 13, month: 10, year: 2026 });
    expect(parseDarwinDate("2028-02-29")).toEqual({ day: 29, month: 2, year: 2028 });
  });

  it("refuses everything else, month-first and day-first included", () => {
    for (const bad of ["2026-02-29", "2026-02-30", "2026-13-01", "2026-00-10", "2026-1-5", "10/13/2026", "13/10/2026", "13-Oct-26", "", "2026-10-13T00:00:00Z"]) {
      expect(parseDarwinDate(bad)).toBeNull();
    }
  });
});

describe("Darwin day boundaries (UTC+09:30, no daylight saving)", () => {
  it("starts a Darwin day at 14:30 UTC the evening before", () => {
    expect(darwinDayStartUtc(day("2026-10-13")).toISOString()).toBe("2026-10-12T14:30:00.000Z");
    expect(darwinDayStartUtc(day("2026-01-01")).toISOString()).toBe("2025-12-31T14:30:00.000Z");
  });

  it("ends it, exclusively, at the start of the next one", () => {
    expect(darwinNextDayStartUtc(day("2026-10-13")).toISOString()).toBe("2026-10-13T14:30:00.000Z");
    expect(darwinNextDayStartUtc(day("2026-12-31")).toISOString()).toBe("2026-12-31T14:30:00.000Z");
  });

  it("has the same 24-hour length in every month (no daylight saving)", () => {
    for (const d of ["2026-03-28", "2026-04-05", "2026-10-03", "2026-10-04", "2026-11-01"]) {
      const start = darwinDayStartUtc(day(d)).getTime();
      expect(darwinNextDayStartUtc(day(d)).getTime() - start).toBe(24 * 60 * 60 * 1000);
    }
  });

  it("includes an instant just inside the day and excludes the one just past it", () => {
    const start = darwinDayStartUtc(day("2026-10-13")).getTime();
    const end = darwinNextDayStartUtc(day("2026-10-13")).getTime();
    const lateEvening = new Date("2026-10-13T14:29:59.999Z").getTime(); // 23:59:59.999 in Darwin
    const midnight = new Date("2026-10-13T14:30:00.000Z").getTime(); // 00:00 on the 14th in Darwin
    expect(lateEvening >= start && lateEvening < end).toBe(true);
    expect(midnight >= start && midnight < end).toBe(false);
  });
});

describe("formatDarwinDateTime", () => {
  it("writes DD/MM/YYYY HH:mm on a 24-hour Darwin clock", () => {
    expect(formatDarwinDateTime(new Date("2026-10-12T14:30:00Z"))).toBe("13/10/2026 00:00");
    expect(formatDarwinDateTime(new Date("2026-10-13T03:07:00Z"))).toBe("13/10/2026 12:37");
    expect(formatDarwinDateTime(new Date("2026-10-13T14:29:59Z"))).toBe("13/10/2026 23:59");
  });

  it("is day first: 1 February reads 01/02, never 02/01", () => {
    expect(formatDarwinDateTime(new Date("2026-02-01T05:00:00Z"))).toBe("01/02/2026 14:30");
  });

  it("rolls the date forward when Darwin is already tomorrow", () => {
    expect(formatDarwinDateTime(new Date("2026-12-31T14:30:00Z"))).toBe("01/01/2027 00:00");
    expect(formatDarwinDateTime(new Date("2028-02-28T15:00:00Z"))).toBe("29/02/2028 00:30");
  });
});

describe("darwinFileDate", () => {
  it("is YYYYMMDD by the Darwin calendar", () => {
    expect(darwinFileDate(new Date("2026-10-13T02:00:00Z"))).toBe("20261013");
    expect(darwinFileDate(new Date("2026-10-13T14:30:00Z"))).toBe("20261014");
    expect(darwinFileDate(new Date("2026-01-05T00:00:00Z"))).toBe("20260105");
  });
});

describe("independence from the process time zone", () => {
  // Jest gives each test file its own copy of process.env, so setting TZ here
  // would not reach the real clock. Prove it the other way: every local-time
  // accessor on Date throws, and the helpers still work, so none of them is used.
  const LOCAL_TIME_METHODS = [
    "getDate",
    "getDay",
    "getFullYear",
    "getHours",
    "getMilliseconds",
    "getMinutes",
    "getMonth",
    "getSeconds",
    "getTimezoneOffset",
    "toDateString",
    "toLocaleDateString",
    "toLocaleString",
    "toLocaleTimeString",
    "toString",
    "toTimeString",
  ] as const;

  afterEach(() => jest.restoreAllMocks());

  it("never reads Date's local-time accessors", () => {
    for (const method of LOCAL_TIME_METHODS) {
      jest.spyOn(Date.prototype, method).mockImplementation(() => {
        throw new Error(`Date.prototype.${method} depends on the process time zone`);
      });
    }

    expect(darwinDayStartUtc(day("2026-10-04")).toISOString()).toBe("2026-10-03T14:30:00.000Z");
    expect(darwinNextDayStartUtc(day("2026-10-04")).toISOString()).toBe("2026-10-04T14:30:00.000Z");
    expect(formatDarwinDateTime(new Date("2026-10-03T14:30:00Z"))).toBe("04/10/2026 00:00");
    expect(darwinFileDate(new Date("2026-04-04T14:30:00Z"))).toBe("20260405");
    expect(parseDarwinDate("2026-10-04")).toEqual({ day: 4, month: 10, year: 2026 });
  });
});
