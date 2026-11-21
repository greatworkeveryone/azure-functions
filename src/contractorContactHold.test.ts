import { contactChangeHolds, contactChangeSentence, holdEndsAt } from "./contractorContactHold";

const FRI = new Date("2026-11-20T02:00:00Z");
const MON = new Date("2026-11-23T02:00:00Z");

describe("the hold after a contractor's email or ABN changes (SECA-04)", () => {
  it("lasts two business days: Friday's change holds through Tuesday", () => {
    expect(holdEndsAt(FRI).toISOString()).toBe("2026-11-24T02:00:00.000Z");
    expect(holdEndsAt(MON).toISOString()).toBe("2026-11-25T02:00:00.000Z");
  });
  it("holds while unconfirmed and inside the window, not after it", () => {
    const facts = { changedAt: FRI, changedBy: "Sam", confirmedAt: null };
    expect(contactChangeHolds(facts, new Date("2026-11-23T10:00:00Z"))).toBe(true);
    expect(contactChangeHolds(facts, new Date("2026-11-24T03:00:00Z"))).toBe(false);
  });
  it("a second person's confirmation ends it at once, and no change means no hold", () => {
    expect(contactChangeHolds({ changedAt: FRI, changedBy: "Sam", confirmedAt: new Date("2026-11-20T05:00:00Z") }, new Date("2026-11-21T00:00:00Z"))).toBe(false);
    expect(contactChangeHolds({ changedAt: null, changedBy: null, confirmedAt: null })).toBe(false);
  });
  it("names the change in D/M/Y as Darwin reads it", () => {
    expect(contactChangeSentence({ changedAt: new Date("2026-11-20T20:00:00Z"), changedBy: "Sam Lee" })).toBe("Email changed on 21/11/2026 by Sam Lee");
  });
});
