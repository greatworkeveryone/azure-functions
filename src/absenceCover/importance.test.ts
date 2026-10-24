/// <reference types="jest" />
import { FACTS } from "../__tests__/fixtures/absenceCover";
import { decisionImportance, escalationImportance, jobImportance, moneyImportance, teamMoneyThreshold } from "./importance";

describe("importance", () => {
  it.each([
    ["Critical", "high"],
    ["High", "high"],
    ["Normal", "medium"],
    ["Low", "low"],
    [null, "medium"],
  ] as const)("a %s priority job is %s", (priority, expected) => {
    expect(jobImportance(priority).importance).toBe(expected);
  });

  it("rates an emergency or urgent decision high and the rest medium", () => {
    expect(decisionImportance("emergency").importance).toBe("high");
    expect(decisionImportance("urgent").importance).toBe("high");
    for (const tier of ["soon", "routine", "fixed"]) expect(decisionImportance(tier).importance).toBe("medium");
  });

  it("rates an escalation at level 2 or above, an urgent one, and a lease deadline high", () => {
    expect(escalationImportance({ level: 2, policyKey: "job.stalled_unacknowledged", urgent: false })).toEqual({ code: "escalation_level", importance: "high" });
    expect(escalationImportance({ level: 1, policyKey: "job.critical", urgent: true })).toEqual({ code: "urgent", importance: "high" });
    expect(escalationImportance({ level: 1, policyKey: "lease.option_deadline", urgent: false })).toEqual({ code: "lease_deadline", importance: "high" });
    expect(escalationImportance({ level: 1, policyKey: "rent_review.overdue", urgent: false })).toEqual({ code: "lease_deadline", importance: "high" });
    expect(escalationImportance({ level: 1, policyKey: "job.unassigned", urgent: false })).toEqual({ code: "default", importance: "medium" });
  });

  it("works out the team threshold from the highest limit among the owner's team", () => {
    expect(teamMoneyThreshold("facilities_manager", FACTS.limits)).toBe(10_000);
    expect(teamMoneyThreshold("facilities", FACTS.limits)).toBe(2_000);
    expect(teamMoneyThreshold("director", FACTS.limits)).toBeNull();
    expect(teamMoneyThreshold("accounts_manager", [{ limit: null, role: "accounts_manager" }])).toBeNull();
  });

  it("rates money above the team threshold high, and an unknown amount too", () => {
    expect(moneyImportance(10_001, 10_000).importance).toBe("high");
    expect(moneyImportance(10_000, 10_000).importance).toBe("medium");
    expect(moneyImportance(null, 10_000).importance).toBe("high");
    expect(moneyImportance(Number.NaN, null).importance).toBe("high");
    expect(moneyImportance(500, null).importance).toBe("medium");
  });
});
