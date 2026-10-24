/// <reference types="jest" />
import { DIRECTORY, FACTS, absent, context, item, user } from "../__tests__/fixtures/absenceCover";
import { holdsCapability, ineligibleReason, someoneElseCanCover } from "./eligibility";

const fay = DIRECTORY[0];
const max = DIRECTORY[1];
const director = DIRECTORY[3];
const admin = DIRECTORY[8];

describe("holdsCapability", () => {
  it("reads the single who-can-do-what table, and never gives admin the work", () => {
    expect(holdsCapability("facilities", "editJobs")).toBe(true);
    expect(holdsCapability("cfo", "editJobs")).toBe(true);
    expect(holdsCapability("user", "editJobs")).toBe(false);
    expect(holdsCapability("admin", "editJobs")).toBe(true);
    expect(holdsCapability("director", "respondToDecision")).toBe(true);
  });
});

describe("ineligibleReason: the order of the checks", () => {
  const ctx = context();

  it("is none for a person who may take it", () => {
    expect(ineligibleReason(item(), max, ctx)).toBeNull();
  });

  it.each([
    ["the person who is away", fay, item(), "owner"],
    ["someone who is away too", max, item(), "absent"],
    ["admin on a real record", admin, item(), "admin"],
    ["the person who raised it", max, item({ raisedByUserId: 2 }), "raiser"],
    ["someone without the capability", user(10, "user"), item(), "capability"],
    ["someone below the role an escalation is aimed at", max, item({ capability: null, minRole: "director" }), "capability"],
  ])("refuses %s", (_label, person, subject, reason) => {
    const away = reason === "absent" ? new Set([1, 2]) : new Set([1]);
    expect(ineligibleReason(subject, person, context({ absentIds: away }))).toBe(reason);
  });

  it("lets admin take a test record, the one place decision 4 allows (never inventoried, but the rule is the money rule's)", () => {
    expect(ineligibleReason(item({ isTest: true }), admin, ctx)).toBeNull();
  });

  it("checks that someone who is away is refused before anything else about them", () => {
    expect(ineligibleReason(item({ raisedByUserId: 2 }), max, context({ absentIds: new Set([1, 2]) }))).toBe("absent");
  });
});

describe("ineligibleReason: money", () => {
  const quote = (amount: number | null, createdByName: string | null = "Someone Else") =>
    item({ capability: null, money: { amount, buildingId: 3, createdByName, subject: "quote" }, move: "notice", type: "approval" });
  const ctx = context({ moneyFacts: FACTS });

  it("lets a person approve what their limit covers, and no more", () => {
    expect(ineligibleReason(quote(9_000), max, ctx)).toBeNull();
    expect(ineligibleReason(quote(10_000), max, ctx)).toBeNull();
    expect(ineligibleReason(quote(10_001), max, ctx)).toBe("money_limit");
  });

  it("needs a director for an unknown amount or one above the director threshold", () => {
    expect(ineligibleReason(quote(null), max, ctx)).toBe("money_limit");
    expect(ineligibleReason(quote(60_000), user(5, "cfo"), ctx)).toBe("money_limit");
    expect(ineligibleReason(quote(60_000), director, ctx)).toBeNull();
  });

  it("refuses a plain facilities officer, who may not approve quotes on their own authority", () => {
    expect(ineligibleReason(quote(100), user(7, "facilities"), ctx)).toBe("money_limit");
  });

  it("never gives a quote to the person who added it, unless they are a director", () => {
    expect(ineligibleReason(quote(9_000, "Max Manager"), max, ctx)).toBe("creator");
    expect(ineligibleReason(quote(9_000, "Dee Director"), director, ctx)).toBeNull();
  });

  it("refuses everyone when the approval facts could not be loaded", () => {
    expect(ineligibleReason(quote(100), max, context({ moneyFacts: null }))).toBe("money_limit");
  });
});

describe("someoneElseCanCover", () => {
  const quote = item({ capability: null, money: { amount: 5_000, buildingId: 3, createdByName: null, subject: "quote" }, move: "notice", type: "approval" });

  it("is true while anyone who is in could approve", () => {
    expect(someoneElseCanCover(quote, context())).toBe(true);
  });

  it("is false when every person who could approve is away", () => {
    expect(someoneElseCanCover(quote, context({ absentIds: new Set([1, 2, 3, 4, 5, 6, 8]) }))).toBe(false);
  });

  it("never counts the person who is away", () => {
    expect(someoneElseCanCover(item({ ownerUserId: 2 }), context({ directory: [max], absentIds: new Set([2]) }))).toBe(false);
    expect(absent().userId).toBe(1);
  });
});
