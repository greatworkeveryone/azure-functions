import { ASSET_CATEGORIES } from "../../assetRegister";
import { checkTriageReading, MAX_NAME_CHARS } from "./validate";

const good = { buildingName: "Frogmore House", category: "Lifts", intent: "maintenance_request", jobNumber: 42, tenancyName: "Acme Pty Ltd", urgency: "high" };

describe("checkTriageReading", () => {
  it("accepts a full reading and copies out only what it knows", () => {
    expect(checkTriageReading(good)).toEqual({ ok: true, value: good });
  });

  it("accepts an intent alone, and nulls or blanks for the rest", () => {
    expect(checkTriageReading({ intent: "other" })).toEqual({ ok: true, value: { buildingName: null, category: null, intent: "other", jobNumber: null, tenancyName: null, urgency: null } });
    expect(checkTriageReading({ ...good, buildingName: null, category: null, jobNumber: null, tenancyName: "  ", urgency: null })).toMatchObject({ ok: true, value: { tenancyName: null } });
  });

  it.each(ASSET_CATEGORIES)("accepts the maintenance category %s", (category) => {
    expect(checkTriageReading({ ...good, category }).ok).toBe(true);
  });

  it.each([
    ["not an object", "text"],
    ["an array", [good]],
    ["null", null],
    ["no intent", { ...good, intent: undefined }],
    ["an intent that is not one of the kinds", { ...good, intent: "spam" }],
    ["a category that is not a maintenance category", { ...good, category: "Plumbing" }],
    ["an urgency that is not a level", { ...good, urgency: "now" }],
    ["a job number that is a string", { ...good, jobNumber: "42" }],
    ["a job number of zero", { ...good, jobNumber: 0 }],
    ["a fractional job number", { ...good, jobNumber: 4.5 }],
    ["a job number past the integer range", { ...good, jobNumber: 2 ** 31 }],
    ["a field it should not have", { ...good, assignTo: "Fay" }],
    ["a person to hand it to", { ...good, assignee: 4 }],
    ["a building name that is not text", { ...good, buildingName: 7 }],
    ["a building name that is too long", { ...good, buildingName: "x".repeat(MAX_NAME_CHARS + 1) }],
    ["a name with markup", { ...good, tenancyName: "<b>Acme</b>" }],
    ["a name with a link", { ...good, tenancyName: "https://evil.example" }],
    ["a name with a line break", { ...good, buildingName: "Frogmore\nHouse" }],
  ])("refuses %s", (_label, value) => {
    expect(checkTriageReading(value).ok).toBe(false);
  });
});
