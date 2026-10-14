import { defaultAccessProfile, parseStoredProfile, validateAccessProfile } from "./profile";

describe("defaultAccessProfile", () => {
  it("is Darwin business hours, Monday to Saturday, Australia", () => {
    expect(defaultAccessProfile("accounts")).toEqual({
      callOutAllowed: false,
      countries: ["AU"],
      days: [1, 2, 3, 4, 5, 6],
      hoursEnd: "20:00",
      hoursStart: "06:00",
      timeZone: "Australia/Darwin",
    });
  });

  it("allows call-outs for field staff", () => {
    expect(defaultAccessProfile("facilities").callOutAllowed).toBe(true);
    expect(defaultAccessProfile("facilities_manager").callOutAllowed).toBe(true);
    expect(defaultAccessProfile(null).callOutAllowed).toBe(false);
  });
});

describe("parseStoredProfile", () => {
  it("uses the role default when nothing is stored", () => {
    expect(parseStoredProfile(null, "facilities")).toEqual(defaultAccessProfile("facilities"));
  });

  it("reads a stored profile", () => {
    const stored = JSON.stringify({
      callOutAllowed: false,
      countries: ["DK", "AU"],
      days: [1, 2, 3, 4, 5],
      hoursEnd: "23:00",
      hoursStart: "07:00",
      timeZone: "Europe/Copenhagen",
    });
    expect(parseStoredProfile(stored, "admin")).toMatchObject({ countries: ["DK", "AU"], timeZone: "Europe/Copenhagen" });
  });

  it("falls back field by field when the stored JSON is damaged", () => {
    const parsed = parseStoredProfile('{"timeZone":"Mars/Olympus","countries":["dk"]}', "accounts");
    expect(parsed.timeZone).toBe("Australia/Darwin");
    expect(parsed.countries).toEqual(["DK"]);
    expect(parseStoredProfile("not json", "accounts")).toEqual(defaultAccessProfile("accounts"));
  });
});

describe("validateAccessProfile", () => {
  const good = {
    callOutAllowed: true,
    countries: ["au", "DK"],
    days: [1, 2, 3, 4, 5, 6],
    hoursEnd: "20:00",
    hoursStart: "06:00",
    timeZone: "Australia/Darwin",
  };

  it("accepts and normalises a complete profile", () => {
    const result = validateAccessProfile(good);
    expect(result).toEqual({ ok: true, profile: { ...good, countries: ["AU", "DK"] } });
  });

  it.each([
    [{ ...good, timeZone: "Nowhere/Special" }, /time zone/i],
    [{ ...good, hoursStart: "6am" }, /hoursStart/],
    [{ ...good, hoursEnd: "05:00" }, /after/],
    [{ ...good, days: [] }, /days/],
    [{ ...good, days: [0, 8] }, /days/],
    [{ ...good, countries: ["Australia"] }, /countries/],
    [{ ...good, countries: [] }, /countries/],
    [{ ...good, callOutAllowed: "yes" }, /callOutAllowed/],
    [null, /profile/i],
  ])("refuses %j", (input, message) => {
    const result = validateAccessProfile(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(message);
  });

  it("accepts 24:00 as the end of the day", () => {
    expect(validateAccessProfile({ ...good, hoursEnd: "24:00" }).ok).toBe(true);
  });
});
