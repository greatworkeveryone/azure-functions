import {
  CHARGE_CODES,
  LEGACY_BUILDING_CODES,
  MYOB_PURCHASE_NUMBER_MAX,
  NON_BUILDING_CODES,
  chargeCodeForCategory,
  chargeCodeForJob,
  darwinDate,
  formatDarwinYYMMDD,
  formatPoReference,
  isChargeCode,
  parseReference,
} from "../reference-codes";

// Midday in Darwin on 13 Oct 2026 (UTC+9:30, no DST) is 02:30 UTC the same day.
const NOON_DARWIN = new Date("2026-10-13T02:30:00Z");

describe("code tables", () => {
  it("has the full charge code list, including case-sensitive SECr", () => {
    expect(Object.keys(CHARGE_CODES)).toHaveLength(46);
    expect(CHARGE_CODES.SECr).toBe("Chubb residencies");
    expect(CHARGE_CODES.secr).toBeUndefined();
  });

  it("keeps McM mixed-case", () => {
    expect(LEGACY_BUILDING_CODES.McM).toBe("McMinn Street");
    expect(LEGACY_BUILDING_CODES.MCM).toBeUndefined();
  });

  it("has every building and non-building code from the sheet", () => {
    expect(Object.keys(LEGACY_BUILDING_CODES)).toHaveLength(24);
    expect(Object.keys(NON_BUILDING_CODES).sort()).toEqual(["ALL", "FU", "HMC", "MS", "OE", "TR", "TU"]);
  });

  it("never reuses a code between buildings and non-buildings", () => {
    const overlap = Object.keys(LEGACY_BUILDING_CODES).filter((c) => c in NON_BUILDING_CODES);
    expect(overlap).toEqual([]);
  });
});

describe("Darwin dates", () => {
  it("uses the Darwin calendar day, not the UTC day", () => {
    // 20:00 UTC on the 12th is 05:30 on the 13th in Darwin.
    expect(formatDarwinYYMMDD(new Date("2026-10-12T20:00:00Z"))).toBe("261013");
    // 15:00 UTC on the 13th is 00:30 on the 14th in Darwin.
    expect(formatDarwinYYMMDD(new Date("2026-10-13T15:00:00Z"))).toBe("261014");
  });

  it("rolls over at Darwin midnight, which is 14:30 UTC", () => {
    expect(formatDarwinYYMMDD(new Date("2026-10-13T14:29:59Z"))).toBe("261013");
    expect(formatDarwinYYMMDD(new Date("2026-10-13T14:30:00Z"))).toBe("261014");
  });

  it("rolls the year over in Darwin first", () => {
    expect(formatDarwinYYMMDD(new Date("2025-12-31T15:00:00Z"))).toBe("260101");
    expect(darwinDate(new Date("2025-12-31T15:00:00Z"))).toEqual({ year: 2026, month: 1, day: 1 });
  });
});

describe("formatPoReference", () => {
  const base = { buildingCode: "66S", chargeCode: "m", date: NOON_DARWIN, existing: [] as string[] };

  it("builds building + charge + YYMMDD", () => {
    expect(formatPoReference(base)).toBe("66Sm261013");
  });

  it("keeps the case of the codes", () => {
    expect(formatPoReference({ ...base, buildingCode: "McM", chargeCode: "gm" })).toBe("McMgm261013");
    expect(formatPoReference({ ...base, buildingCode: "RCK", chargeCode: "SECr" })).toBe("RCKSECr261013");
  });

  it("uses the Darwin date", () => {
    expect(formatPoReference({ ...base, date: new Date("2026-10-12T20:00:00Z") })).toBe("66Sm261013");
  });

  it("appends the first free suffix from b on a collision", () => {
    expect(formatPoReference({ ...base, existing: ["66Sm261013"] })).toBe("66Sm261013b");
    expect(formatPoReference({ ...base, existing: ["66Sm261013", "66Sm261013b"] })).toBe("66Sm261013c");
  });

  it("fills a gap rather than jumping past it", () => {
    expect(formatPoReference({ ...base, existing: ["66Sm261013", "66Sm261013c"] })).toBe("66Sm261013b");
  });

  it("ignores other buildings, charges and days", () => {
    const existing = ["6Sm261013", "66Se261013", "66Sm261012", "66Sm2610130"];
    expect(formatPoReference({ ...base, existing })).toBe("66Sm261013");
  });

  it("does not suffix when only a suffixed number exists", () => {
    expect(formatPoReference({ ...base, existing: ["66Sm261013b"] })).toBe("66Sm261013");
  });

  it("is case-sensitive about what is taken", () => {
    expect(formatPoReference({ ...base, buildingCode: "McM", existing: ["MCMm261013"] })).toBe("McMm261013");
  });

  it("throws when the suffixes run out", () => {
    const all = ["66Sm261013", ..."bcdefghijklmnopqrstuvwxyz"].map((x, i) => (i === 0 ? x : `66Sm261013${x}`));
    expect(() => formatPoReference({ ...base, existing: all })).toThrow(/No free suffix/);
  });

  it("accepts exactly 13 characters and rejects 14", () => {
    // 3 + 4 + 6 = 13
    const ok = formatPoReference({ ...base, buildingCode: "RCK", chargeCode: "SECr" });
    expect(ok).toHaveLength(MYOB_PURCHASE_NUMBER_MAX);
    // The collision suffix pushes it to 14.
    expect(() =>
      formatPoReference({ ...base, buildingCode: "RCK", chargeCode: "SECr", existing: [ok] }),
    ).toThrow(/14 characters/);
    expect(() => formatPoReference({ ...base, buildingCode: "ABCDE", chargeCode: "SECr" })).toThrow(
      /MYOB allows 13/,
    );
  });

  it("keeps the longest real combination (3 + 3 + 6 + suffix) within the limit", () => {
    const ref = formatPoReference({
      buildingCode: "MAN",
      chargeCode: "gas",
      date: NOON_DARWIN,
      existing: ["MANgas261013"],
    });
    expect(ref).toBe("MANgas261013b");
    expect(ref).toHaveLength(13);
  });

  it.each([
    ["", "m"],
    ["66S", ""],
    ["66-S", "m"],
    ["66S", "m "],
    ["66S", "é"],
  ])("rejects empty or non-alphanumeric codes (%j, %j)", (buildingCode, chargeCode) => {
    expect(() => formatPoReference({ ...base, buildingCode, chargeCode })).toThrow(/Invalid/);
  });

  it("produces numbers parseReference reads back", () => {
    const ref = formatPoReference({ ...base, existing: ["66Sm261013"] });
    const parsed = parseReference(ref);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      buildingCode: "66S",
      chargeCode: "m",
      suffix: "b",
      period: { kind: "day", from: "2026-10-13", to: "2026-10-13" },
    });
  });
});

describe("parseReference", () => {
  it("reads a day reference", () => {
    expect(parseReference("66Sm261013")).toEqual([
      {
        buildingCode: "66S",
        buildingLabel: "66 Smith St",
        chargeCode: "m",
        period: { kind: "day", from: "2026-10-13", to: "2026-10-13" },
        suffix: null,
      },
    ]);
  });

  it("reads a monthly reference", () => {
    expect(parseReference("9Ce2610")).toEqual([
      {
        buildingCode: "9C",
        buildingLabel: "9-11 Cavanagh Street",
        chargeCode: "e",
        period: { kind: "month", from: "2026-10-01", to: "2026-10-31" },
        suffix: null,
      },
    ]);
  });

  it("reads a quarter with the case-sensitive McM", () => {
    expect(parseReference("McMgm26q3")).toEqual([
      {
        buildingCode: "McM",
        buildingLabel: "McMinn Street",
        chargeCode: "gm",
        period: { kind: "quarter", from: "2026-07-01", to: "2026-09-30" },
        suffix: null,
      },
    ]);
  });

  it("reads an annual reference on a non-building code", () => {
    expect(parseReference("ALLins26a")).toEqual([
      {
        buildingCode: "ALL",
        buildingLabel: "Many buildings",
        chargeCode: "ins",
        period: { kind: "year", from: "2026-01-01", to: "2026-12-31" },
        suffix: null,
      },
    ]);
  });

  it("reads a two-yearly reference as ending in YY", () => {
    const [only] = parseReference("66Sm26a2");
    expect(only.period).toEqual({ kind: "twoYear", from: "2025-01-01", to: "2026-12-31" });
    expect(only.suffix).toBeNull();
  });

  it("does not confuse a two-yearly reference with an annual one plus anything", () => {
    expect(parseReference("66Sm26a2")).toHaveLength(1);
    expect(parseReference("66Sm26a")[0].period.kind).toBe("year");
    expect(parseReference("66Sm26a3")).toEqual([]);
  });

  it.each([
    ["HHse26s1", "half", "2026-01-01", "2026-06-30"],
    ["HHse26s2", "half", "2026-07-01", "2026-12-31"],
    ["HHse26q1", "quarter", "2026-01-01", "2026-03-31"],
    ["HHse26q2", "quarter", "2026-04-01", "2026-06-30"],
    ["HHse26q4", "quarter", "2026-10-01", "2026-12-31"],
    ["HHse2602", "month", "2026-02-01", "2026-02-28"],
    ["HHse2402", "month", "2024-02-01", "2024-02-29"],
    ["HHse240229", "day", "2024-02-29", "2024-02-29"],
  ])("period %s", (ref, kind, from, to) => {
    const [only] = parseReference(ref);
    expect(only.period).toEqual({ kind, from, to });
  });

  it("reads a collision suffix after any date shape", () => {
    expect(parseReference("66Sm261013b")[0]).toMatchObject({ suffix: "b", period: { kind: "day" } });
    expect(parseReference("66Sm261013z")[0]).toMatchObject({ suffix: "z" });
    expect(parseReference("9Ce2610c")[0]).toMatchObject({ suffix: "c", period: { kind: "month" } });
    expect(parseReference("McMgm26q3b")[0]).toMatchObject({ suffix: "b", period: { kind: "quarter" } });
  });

  it("does not treat 'a' or an uppercase letter as a suffix", () => {
    expect(parseReference("66Sm261013a")).toEqual([]);
    expect(parseReference("66Sm261013B")).toEqual([]);
  });

  describe("ambiguous prefixes", () => {
    it("4S and 45S stay distinct", () => {
      expect(parseReference("4Sm261013").map((r) => r.buildingCode)).toEqual(["4S"]);
      expect(parseReference("45Sm261013").map((r) => r.buildingCode)).toEqual(["45S"]);
      expect(parseReference("49Sm261013").map((r) => r.buildingCode)).toEqual(["49S"]);
    });

    it("6S and 66S stay distinct", () => {
      expect(parseReference("6Sm261013").map((r) => r.buildingCode)).toEqual(["6S"]);
      expect(parseReference("66Sm261013").map((r) => r.buildingCode)).toEqual(["66S"]);
    });

    it("9C, 9M and 2P/23T/26G stay distinct", () => {
      expect(parseReference("9Mm261013").map((r) => r.buildingCode)).toEqual(["9M"]);
      expect(parseReference("2Pm261013").map((r) => r.buildingCode)).toEqual(["2P"]);
      expect(parseReference("23Tm261013").map((r) => r.buildingCode)).toEqual(["23T"]);
      expect(parseReference("26Gm261013").map((r) => r.buildingCode)).toEqual(["26G"]);
    });

    it("longer charge codes win the split, not a shorter prefix of them", () => {
      // me (mechanical) is not m + "e2610..."; the date part cannot start with a letter.
      expect(parseReference("66Sme261013").map((r) => r.chargeCode)).toEqual(["me"]);
      expect(parseReference("66Sins261013").map((r) => r.chargeCode)).toEqual(["ins"]);
      expect(parseReference("66Sreg2610").map((r) => r.chargeCode)).toEqual(["reg"]);
    });

    it("no two building/charge pairs spell the same reference", () => {
      const buildings = [...Object.keys(LEGACY_BUILDING_CODES), ...Object.keys(NON_BUILDING_CODES)];
      const seen = new Map<string, string>();
      const collisions: string[] = [];
      for (const b of buildings) {
        for (const c of Object.keys(CHARGE_CODES)) {
          const ref = `${b}${c}261013`;
          if (seen.has(ref)) collisions.push(`${ref}: ${seen.get(ref)} vs ${b}+${c}`);
          seen.set(ref, `${b}+${c}`);
          const parsed = parseReference(ref);
          const wanted = parsed.some((p) => p.buildingCode === b && p.chargeCode === c);
          if (!wanted) collisions.push(`${ref} does not parse back to ${b}+${c}`);
        }
      }
      expect(collisions).toEqual([]);
    });
  });

  describe("rejects", () => {
    it.each([
      [""],
      ["   "],
      ["hello world"],
      ["66S"],
      ["66Sm"],
      ["66Sm26"],
      ["66Sm2"],
      ["66Sm26130"],
      ["66Sm2613"], // month 13
      ["66Sm2600"], // month 0
      ["66Sm261032"], // day 32
      ["66Sm261000"], // day 0
      ["66Sm250229"], // 2025 is not a leap year
      ["66Sm26q5"],
      ["66Sm26s3"],
      ["66Sm261013bb"],
      ["Sm261013"], // no building
      ["66S261013"], // no charge code
      ["260419-PO-42-ACM-7"], // old document number
      ["BP26a2"], // not-adopted subscription code
    ])("%j", (ref) => {
      expect(parseReference(ref)).toEqual([]);
    });

    it("is case-sensitive for building and charge codes", () => {
      expect(parseReference("66SM261013")).toEqual([]);
      expect(parseReference("66sm261013")).toEqual([]);
      expect(parseReference("mcmgm26q3")).toEqual([]);
      expect(parseReference("MCMgm26q3")).toEqual([]);
      expect(parseReference("McMGM26q3")).toEqual([]);
      expect(parseReference("RCKsecr261013")).toEqual([]);
      expect(parseReference("RCKSECr261013")).toHaveLength(1);
    });
  });

  it("trims surrounding whitespace only", () => {
    expect(parseReference("  66Sm261013\n")).toHaveLength(1);
    expect(parseReference("66 Sm261013")).toEqual([]);
  });

  it("reads the vehicle and vendor codes", () => {
    expect(parseReference("TUvf261013")[0]).toMatchObject({ buildingCode: "TU", chargeCode: "vf" });
    expect(parseReference("HMCvr26q1")[0]).toMatchObject({ buildingCode: "HMC", chargeCode: "vr" });
    expect(parseReference("MSps2610")[0]).toMatchObject({ buildingCode: "MS", chargeCode: "ps" });
    expect(parseReference("TRtr261013")[0]).toMatchObject({ buildingCode: "TR", chargeCode: "tr" });
    expect(parseReference("OEcs2610")[0]).toMatchObject({ buildingCode: "OE", chargeCode: "cs" });
  });

  it("reads the unclear Hingston Beach code as well", () => {
    expect(parseReference("HBm261013")[0]).toMatchObject({ buildingCode: "HB" });
  });

  describe("database-only building codes", () => {
    it("are accepted when supplied", () => {
      expect(parseReference("13Zm261013")).toEqual([]);
      const [only] = parseReference("13Zm261013", { "13Z": "13 Zebra Street" });
      expect(only).toMatchObject({ buildingCode: "13Z", buildingLabel: "13 Zebra Street" });
    });

    it("never override the sheet", () => {
      const [only] = parseReference("66Sm261013", { "66S": "Something else" });
      expect(only.buildingLabel).toBe("66 Smith St");
    });
  });
});

describe("isChargeCode", () => {
  it("accepts listed codes and rejects everything else", () => {
    expect(isChargeCode("m")).toBe(true);
    expect(isChargeCode("SECr")).toBe(true);
    expect(isChargeCode("M")).toBe(false);
    expect(isChargeCode("toString")).toBe(false);
    expect(isChargeCode("")).toBe(false);
    expect(isChargeCode(undefined)).toBe(false);
    expect(isChargeCode(5)).toBe(false);
  });
});

describe("chargeCodeForCategory", () => {
  it.each([
    ["Electrical", "e"],
    ["electrician call-out", "e"],
    ["Lifts", "lm"],
    ["Lift", "lm"],
    ["Elevator maintenance", "lm"],
    ["Fire alarm", "fa"],
    ["Smoke detector", "fa"],
    ["Fire & life safety", "fs"],
    ["Fire Services & Equipment", "fs"],
    ["Fire sprinklers", "fs"],
    ["Fire testing", "ft"],
    ["Grounds", "gm"],
    ["Gardening", "gm"],
    ["Landscaping", "gm"],
    ["Pool", "pm"],
    ["Pool maintenance", "pm"],
    ["Cleaning", "cl"],
    ["Cleaning & Sanitation", "cl"],
    ["Security", "se"],
    ["CCTV", "se"],
    ["Waste removal", "w"],
    ["Rubbish", "w"],
    ["Keys", "k"],
    ["Hard Keys", "k"],
    ["Locks", "k"],
    ["Access System", "k"],
    ["Mechanical", "me"],
    ["HVAC / mechanical", "me"],
    ["HVAC", "me"],
    ["Air-con", "me"],
    ["Air conditioning", "me"],
    ["Plumbing", "m"],
    ["Hydraulic", "m"],
    ["Drainage", "m"],
    ["Project", "pr"],
    ["Capital works", "pr"],
    ["Projects", "pr"],
  ])("%s -> %s", (category, expected) => {
    expect(chargeCodeForCategory(category)).toBe(expected);
  });

  it.each([["Common Areas"], ["Tenancy Works"], ["Other"], ["Compliance"], ["Signage"], ["Car Park"], [""], ["   "]])(
    "falls back to m for %j",
    (category) => {
      expect(chargeCodeForCategory(category)).toBe("m");
    },
  );

  it("falls back to m for null and undefined", () => {
    expect(chargeCodeForCategory(null)).toBe("m");
    expect(chargeCodeForCategory(undefined)).toBe("m");
  });

  it("does not match inside other words", () => {
    expect(chargeCodeForCategory("Pooling water")).toBe("m");
    expect(chargeCodeForCategory("Ground floor")).toBe("m");
    expect(chargeCodeForCategory("Keyboard")).toBe("m");
  });

  it("puts specific fire rules above the general one", () => {
    expect(chargeCodeForCategory("Fire alarm panel")).toBe("fa");
    expect(chargeCodeForCategory("Fire hydrant")).toBe("fs");
  });

  it("only ever returns listed charge codes and never the legacy SECr", () => {
    const inputs = [
      "Electrical", "Lifts", "Fire alarm", "Fire services", "Fire testing", "Grounds", "Pool", "Cleaning",
      "Security", "Chubb residencies", "SECr", "secr", "Waste", "Keys", "Mechanical", "Plumbing", "Project", "x",
    ];
    for (const input of inputs) {
      const code = chargeCodeForCategory(input);
      expect(isChargeCode(code)).toBe(true);
      expect(code).not.toBe("SECr");
    }
  });
});

describe("chargeCodeForJob", () => {
  it("prefers the category when it says something", () => {
    expect(chargeCodeForJob({ category: "Electrical", type: "Plumbing" })).toBe("e");
  });

  it("falls through to the work-request type for facilities categories", () => {
    expect(chargeCodeForJob({ category: "Common Areas", type: "Lifts" })).toBe("lm");
    expect(chargeCodeForJob({ category: "Tenancy Works", type: "Electrical", subType: "Meters" })).toBe("e");
  });

  it("falls through to the sub-type, then to m", () => {
    expect(chargeCodeForJob({ category: "Common Areas", type: "Service Contracts", subType: "Cleaning" })).toBe("cl");
    expect(chargeCodeForJob({ category: "Common Areas", type: "Painting" })).toBe("m");
    expect(chargeCodeForJob({})).toBe("m");
  });
});
