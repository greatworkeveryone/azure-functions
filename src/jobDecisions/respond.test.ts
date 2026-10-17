/// <reference types="jest" />
// Reading an answer to a decision request, and the rules about a deferral's date
// (jobs plan A2). Pure.
import { NO_HOLIDAYS } from "../escalation/businessTime";
import { RequestError } from "./request";
import { parseRespondBody, readRowVersion, readStepNote, validateDeferUntil } from "./respond";

const VERSION = Buffer.from([0, 0, 0, 0, 0, 0, 0, 7]).toString("base64");

const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  nextStep: "Pay the invoice",
  outcome: "approve",
  rationale: "The lighting was ordered twice and the first order was paid.",
  requestId: 7,
  rowVersion: VERSION,
  ...over,
});

const refused = (run: () => unknown): RequestError => {
  try {
    run();
  } catch (error) {
    if (error instanceof RequestError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
};

describe("parseRespondBody", () => {
  it("reads an approval with the next step and its owner", () => {
    expect(parseRespondBody(body({ nextStepOwner: { userId: 9 } }))).toEqual({
      deferUntil: null,
      nextStep: "Pay the invoice",
      nextStepOwner: { kind: "user", userId: 9 },
      outcome: "approve",
      rationale: "The lighting was ordered twice and the first order was paid.",
      requestId: 7,
      rowVersion: VERSION,
    });
  });

  it("trims the words, takes ids written as digits, and leaves the owner to the job's creator when none is named", () => {
    const parsed = parseRespondBody(body({ nextStep: "  Pay it  ", rationale: "  Because.  ", requestId: "12" }));
    expect(parsed).toMatchObject({ nextStep: "Pay it", nextStepOwner: null, rationale: "Because.", requestId: 12 });
  });

  it("hands a step to a whole role, written any way round", () => {
    expect(parseRespondBody(body({ nextStepOwner: { role: " Accounts_Manager " } })).nextStepOwner).toEqual({ kind: "role", role: "accounts_manager" });
  });

  describe("the outcome", () => {
    it.each(["approve", "deny", "revise"])("%s needs a next step", (outcome) => {
      const error = refused(() => parseRespondBody(body({ nextStep: undefined, outcome })));
      expect(error).toMatchObject({ code: "next_step_required", status: 400 });
    });

    it.each(["approve", "deny", "revise"])("%s refuses a blank next step as it refuses a missing one", (outcome) => {
      for (const nextStep of ["", "   ", null]) {
        expect(refused(() => parseRespondBody(body({ nextStep, outcome })))).toMatchObject({ code: "next_step_required" });
      }
    });

    it("a revision asks what needs changing; an approval or denial asks what happens next", () => {
      expect(refused(() => parseRespondBody(body({ nextStep: undefined, outcome: "revise" }))).message).toMatch(/changing/);
      expect(refused(() => parseRespondBody(body({ nextStep: undefined, outcome: "deny" }))).message).toMatch(/happens next/);
    });

    it("a deferral may leave the next step out, and then has no owner", () => {
      expect(parseRespondBody(body({ deferUntil: "2026-10-23", nextStep: undefined, outcome: "defer" }))).toMatchObject({
        deferUntil: "2026-10-23",
        nextStep: null,
        nextStepOwner: null,
        outcome: "defer",
      });
    });

    it("a deferral may hand on a step as well", () => {
      expect(parseRespondBody(body({ deferUntil: "2026-10-23", outcome: "defer" }))).toMatchObject({ nextStep: "Pay the invoice", outcome: "defer" });
    });

    it.each([undefined, null, "", "approved", "APPROVE", 3, ["approve"]])("refuses the outcome %j (400 outcome_invalid)", (outcome) => {
      expect(refused(() => parseRespondBody(body({ outcome })))).toMatchObject({ code: "outcome_invalid", status: 400 });
    });
  });

  describe("the rationale is mandatory", () => {
    it.each([undefined, null, "", "   ", "\n\t"])("refuses %j (400 rationale_required)", (rationale) => {
      expect(refused(() => parseRespondBody(body({ rationale })))).toMatchObject({ code: "rationale_required", status: 400 });
    });

    it("refuses one that is not text, and one that is too long for the ledger", () => {
      expect(refused(() => parseRespondBody(body({ rationale: 5 })))).toMatchObject({ code: "bad_request" });
      expect(parseRespondBody(body({ rationale: "x".repeat(2000) })).rationale).toHaveLength(2000);
      expect(refused(() => parseRespondBody(body({ rationale: "x".repeat(2001) }))).message).toMatch(/at most 2000/);
    });

    it("is required for a deferral too", () => {
      expect(refused(() => parseRespondBody(body({ deferUntil: "2026-10-23", outcome: "defer", rationale: " " })))).toMatchObject({ code: "rationale_required" });
    });
  });

  describe("the request and its version", () => {
    it.each([undefined, null, 0, -1, 1.5, "abc", "1x", "99999999999", true])("refuses the request id %j", (requestId) => {
      expect(refused(() => parseRespondBody(body({ requestId })))).toMatchObject({ code: "bad_request", status: 400 });
    });

    it("needs the version the screen read, as an 8-byte base64 value", () => {
      for (const rowVersion of [undefined, null, "", "  ", "AAAA", 12, "x".repeat(70), "not base64!"]) {
        expect(refused(() => parseRespondBody(body({ rowVersion }))).message).toMatch(/rowVersion/);
      }
      expect(readRowVersion(` ${VERSION} `)).toBe(VERSION);
    });
  });

  describe("the next step and its owner", () => {
    it("refuses a next step that is too long, or not text", () => {
      expect(parseRespondBody(body({ nextStep: "x".repeat(2000) })).nextStep).toHaveLength(2000);
      expect(refused(() => parseRespondBody(body({ nextStep: "x".repeat(2001) }))).message).toMatch(/at most 2000/);
      expect(refused(() => parseRespondBody(body({ nextStep: 7 }))).message).toMatch(/must be text/);
    });

    it.each([
      ["both a person and a role", { role: "accounts", userId: 9 }],
      ["neither", {}],
      ["a blank person", { userId: "" }],
      ["a bad person id", { userId: "nine" }],
      ["a bad role", { role: 4 }],
      ["a list", [9]],
      ["text", "Alana"],
    ])("refuses an owner naming %s (400)", (_label, nextStepOwner) => {
      expect(refused(() => parseRespondBody(body({ nextStepOwner }))).status).toBe(400);
    });

    it.each(["user", "tenant", "bogus"])("refuses a role that cannot open the escalation inbox, %s (422), so the step would never be seen", (role) => {
      expect(refused(() => parseRespondBody(body({ nextStepOwner: { role } })))).toMatchObject({ code: "next_step_owner_role_not_allowed", status: 422 });
    });

    it("accepts every role that can", () => {
      for (const role of ["accounts", "accounts_manager", "admin", "cfo", "director", "facilities", "facilities_manager"]) {
        expect(parseRespondBody(body({ nextStepOwner: { role } })).nextStepOwner).toEqual({ kind: "role", role });
      }
    });

    it("refuses an owner with no step to do", () => {
      expect(refused(() => parseRespondBody(body({ deferUntil: "2026-10-23", nextStep: undefined, nextStepOwner: { userId: 9 }, outcome: "defer" }))).message).toMatch(
        /needs a nextStep/,
      );
    });
  });

  describe("the day a deferral comes back", () => {
    it("is required to defer, and must be a real date", () => {
      for (const deferUntil of [undefined, null, ""]) {
        expect(refused(() => parseRespondBody(body({ deferUntil, outcome: "defer" })))).toMatchObject({ code: "defer_until_required", status: 400 });
      }
      for (const deferUntil of ["2026-02-30", "23/10/2026", "next week", 20261023, "2026-10-23T00:00:00Z"]) {
        expect(refused(() => parseRespondBody(body({ deferUntil, outcome: "defer" })))).toMatchObject({ code: "defer_until_invalid", status: 400 });
      }
    });

    it.each(["approve", "deny", "revise"])("is refused with %s, which does not come back", (outcome) => {
      expect(refused(() => parseRespondBody(body({ deferUntil: "2026-10-23", outcome })))).toMatchObject({ code: "unexpected_defer_until", status: 400 });
    });

    it("is ignored when blank for the others", () => {
      expect(parseRespondBody(body({ deferUntil: "", outcome: "deny" })).deferUntil).toBeNull();
      expect(parseRespondBody(body({ deferUntil: null, outcome: "deny" })).deferUntil).toBeNull();
    });
  });
});

describe("validateDeferUntil", () => {
  // Monday 2026-10-12, 09:00 Darwin
  const NOW = new Date(Date.UTC(2026, 9, 12, 9, 0) - 9.5 * 3_600_000);
  const check = (date: string, holidays: ReadonlySet<string> = NO_HOLIDAYS) => refused(() => validateDeferUntil(date, NOW, holidays));

  it("accepts a working day after today", () => {
    expect(() => validateDeferUntil("2026-10-13", NOW, NO_HOLIDAYS)).not.toThrow(); // tomorrow
    expect(() => validateDeferUntil("2026-10-23", NOW, NO_HOLIDAYS)).not.toThrow();
  });

  it("refuses today and any day before it, even a working one (422 defer_until_past)", () => {
    expect(check("2026-10-12")).toMatchObject({ code: "defer_until_past", status: 422 });
    expect(check("2026-10-09")).toMatchObject({ code: "defer_until_past", status: 422 });
    expect(check("2025-01-01")).toMatchObject({ code: "defer_until_past" });
  });

  it("counts today in Darwin, not UTC: late on a Darwin Monday is still Monday", () => {
    const lateMonday = new Date(Date.UTC(2026, 9, 12, 8, 0)); // Mon 17:30 Darwin... still 12 Oct
    expect(refused(() => validateDeferUntil("2026-10-12", lateMonday, NO_HOLIDAYS))).toMatchObject({ code: "defer_until_past" });
    const sundayNightUtc = new Date(Date.UTC(2026, 9, 11, 16, 0)); // Mon 01:30 Darwin, 12 Oct
    expect(refused(() => validateDeferUntil("2026-10-12", sundayNightUtc, NO_HOLIDAYS))).toMatchObject({ code: "defer_until_past" });
    expect(() => validateDeferUntil("2026-10-13", sundayNightUtc, NO_HOLIDAYS)).not.toThrow();
  });

  it("refuses a weekend, and a public holiday in ESCALATION_HOLIDAYS (422 defer_until_not_a_working_day)", () => {
    expect(check("2026-10-17")).toMatchObject({ code: "defer_until_not_a_working_day", status: 422 }); // Saturday
    expect(check("2026-10-18")).toMatchObject({ code: "defer_until_not_a_working_day" }); // Sunday
    expect(check("2026-10-14", new Set(["2026-10-14"]))).toMatchObject({ code: "defer_until_not_a_working_day" });
    expect(() => validateDeferUntil("2026-10-15", NOW, new Set(["2026-10-14"]))).not.toThrow();
  });

  it("refuses a day more than a year out (422 defer_until_too_far), as a fixed deadline is", () => {
    expect(() => validateDeferUntil("2027-10-12", NOW, NO_HOLIDAYS)).not.toThrow(); // 365 days ahead, a Tuesday
    expect(check("2027-10-14")).toMatchObject({ code: "defer_until_too_far", status: 422 });
    expect(check("2030-01-01")).toMatchObject({ code: "defer_until_too_far" });
  });
});

describe("readStepNote", () => {
  it("is optional, trimmed, and at most 1000 characters", () => {
    expect(readStepNote(undefined)).toBeNull();
    expect(readStepNote(null)).toBeNull();
    expect(readStepNote("   ")).toBeNull();
    expect(readStepNote("  Paid on the 14th ")).toBe("Paid on the 14th");
    expect(readStepNote("x".repeat(1000))).toHaveLength(1000);
    expect(refused(() => readStepNote("x".repeat(1001))).message).toMatch(/at most 1000/);
    expect(refused(() => readStepNote(5)).message).toMatch(/must be text/);
  });
});
