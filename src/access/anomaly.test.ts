import { describeAnomaly, evaluateAccess, localClock, primaryAnomaly, type AccessFacts } from "./anomaly";
import { defaultAccessProfile } from "./profile";

// Darwin is UTC+09:30 all year. 02:00 Darwin on Thursday 15 Oct 2026 is
// 16:30 UTC on Wednesday 14 Oct.
const DARWIN_0200_THU = new Date("2026-10-14T16:30:00Z");
const DARWIN_1000_THU = new Date("2026-10-15T00:30:00Z");
const DARWIN_1000_SUN = new Date("2026-10-18T00:30:00Z");

const CONNOR = {
  callOutAllowed: false,
  countries: ["DK", "AU"],
  days: [1, 2, 3, 4, 5, 6, 7],
  hoursEnd: "24:00",
  hoursStart: "00:00",
  timeZone: "Europe/Copenhagen",
};

function facts(overrides: Partial<AccessFacts> = {}): AccessFacts {
  const role = overrides.role === undefined ? "facilities" : overrides.role;
  return {
    at: DARWIN_1000_THU,
    burst: false,
    country: "AU",
    deviceSeen: true,
    hasHistory: true,
    kind: "request",
    profile: defaultAccessProfile(role),
    role,
    ...overrides,
  };
}

describe("localClock", () => {
  it("reads the hour, minute and ISO weekday in the profile's zone", () => {
    expect(localClock(DARWIN_0200_THU, "Australia/Darwin")).toEqual({ hour: 2, isoDay: 4, minute: 0 });
    expect(localClock(DARWIN_1000_SUN, "Australia/Darwin")).toEqual({ hour: 10, isoDay: 7, minute: 0 });
  });
});

describe("evaluateAccess — the brief's fixtures", () => {
  it("a Darwin officer at 02:00 with call-outs allowed is not an anomaly", () => {
    expect(evaluateAccess(facts({ at: DARWIN_0200_THU }))).toEqual([]);
  });

  it("an accounts user from outside Australia is new_country", () => {
    expect(evaluateAccess(facts({ country: "US", role: "accounts" }))).toEqual(["new_country"]);
  });

  it("Connor from Denmark is not an anomaly", () => {
    expect(evaluateAccess(facts({ country: "DK", profile: CONNOR, role: "admin" }))).toEqual([]);
  });
});

describe("evaluateAccess — outside_window", () => {
  it("flags an accounts user at 02:00", () => {
    expect(evaluateAccess(facts({ at: DARWIN_0200_THU, role: "accounts" }))).toEqual(["outside_window"]);
  });

  it("flags a Sunday request for a Monday–Saturday profile", () => {
    expect(evaluateAccess(facts({ at: DARWIN_1000_SUN, role: "accounts" }))).toEqual(["outside_window"]);
  });

  it("flags a money action at 02:00 even for a field officer with call-outs", () => {
    expect(evaluateAccess(facts({ at: DARWIN_0200_THU, kind: "money" }))).toEqual(["outside_window"]);
  });

  it("does not flag a director's ordinary request out of hours, but does flag their money action", () => {
    expect(evaluateAccess(facts({ at: DARWIN_0200_THU, role: "director" }))).toEqual([]);
    expect(evaluateAccess(facts({ at: DARWIN_0200_THU, kind: "money", role: "director" }))).toEqual(["outside_window"]);
  });

  it("treats a sign-in like a request", () => {
    expect(evaluateAccess(facts({ at: DARWIN_0200_THU, kind: "signin", role: "accounts" }))).toEqual(["outside_window"]);
  });
});

describe("evaluateAccess — device, burst and unknowns", () => {
  it("flags an unseen device once the person has history", () => {
    expect(evaluateAccess(facts({ deviceSeen: false }))).toEqual(["new_device"]);
  });

  it("does not flag the very first device anyone signs in with", () => {
    expect(evaluateAccess(facts({ deviceSeen: false, hasHistory: false }))).toEqual([]);
  });

  it("flags a burst", () => {
    expect(evaluateAccess(facts({ burst: true }))).toEqual(["burst"]);
  });

  it("never flags new_country when the country is unknown", () => {
    expect(evaluateAccess(facts({ country: null, role: "accounts" }))).toEqual([]);
  });

  it("orders several findings by severity", () => {
    const codes = evaluateAccess(facts({ at: DARWIN_0200_THU, burst: true, country: "US", deviceSeen: false, kind: "money" }));
    expect(codes).toEqual(["new_country", "burst", "outside_window", "new_device"]);
    expect(primaryAnomaly(codes)).toBe("new_country");
    expect(primaryAnomaly([])).toBe("none");
  });
});

describe("describeAnomaly", () => {
  it("says what happened in plain words", () => {
    expect(describeAnomaly("new_country", facts({ country: "US", role: "accounts" }))).toBe(
      "Used Floorplan from US, which is not one of this person's expected countries (AU).",
    );
    expect(describeAnomaly("outside_window", facts({ at: DARWIN_0200_THU, kind: "money" }))).toBe(
      "A money action at 02:00 Thu (Australia/Darwin), outside the expected 06:00–20:00 Mon–Sat.",
    );
    expect(describeAnomaly("burst", facts())).toMatch(/more than 300 requests in 5 minutes/);
    expect(describeAnomaly("new_device", facts())).toMatch(/device or browser not seen/);
  });
});
