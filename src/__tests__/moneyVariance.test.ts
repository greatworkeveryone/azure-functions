import { describe, expect, it } from "@jest/globals";
import type { AuthorityFacts } from "../approvalAuthority";
import { formatDollars, varianceDecision, type VarianceInput } from "../moneyRules";

// R13 (Connor, 13 Oct): a PO or incoming invoice that rises within a margin of
// the originally approved amount stays approved, with a rationale and a named
// manager who could approve the new total themselves.

const AUTHORITY: AuthorityFacts = {
  directorThreshold: 50000,
  isResidence: false,
  limits: [
    { limit: 5000, role: "facilities" },
    { limit: 5000, role: "accounts" },
    { limit: 20000, role: "facilities_manager" },
    { limit: 20000, role: "accounts_manager" },
    { limit: null, role: "cfo" },
  ],
  residenceApprovers: [],
  residenceDirectorFallback: true,
  today: "2026-10-17",
};
const FACTS = { capDollars: 1000, marginPercent: 10 };
const EDITOR = { email: "fi@rp.test", roles: ["facilities"], userId: 3 };
const MANAGER = { displayName: "Mo Manager", email: "mo@rp.test", roles: ["facilities_manager"], userId: 7 };

function input(over: Partial<VarianceInput> = {}): VarianceInput {
  return {
    acceptedAmount: null,
    buildingId: 5,
    editor: EDITOR,
    newAmount: 10600,
    originalAmount: 10000,
    request: { attributedTo: MANAGER, rationale: "Extra valve found on site" },
    subject: "purchase_order",
    ...over,
  };
}
const decide = (over: Partial<VarianceInput> = {}) => varianceDecision(input(over), FACTS, AUTHORITY);

describe("varianceDecision: nothing to decide", () => {
  it("at or below the approved amount, decreases included", () => {
    expect(decide({ newAmount: 10000 }).kind).toBe("no_variance");
    expect(decide({ newAmount: 9000, request: {} }).kind).toBe("no_variance");
  });

  it("with no approved amount to measure against (a contract job)", () => {
    expect(decide({ originalAmount: null, request: {} }).kind).toBe("no_variance");
  });

  it("up to an amount already accepted within the margin, so a send after an accepted edit isn't asked again", () => {
    expect(decide({ acceptedAmount: 10700, newAmount: 10650, request: {} }).kind).toBe("no_variance");
  });
});

describe("varianceDecision: within the margin", () => {
  it("stays approved, with the figures measured against the original amount", () => {
    expect(decide()).toEqual({
      attributedTo: MANAGER,
      figures: { allowance: 1000, deltaAmount: 600, deltaPercent: 6, newAmount: 10600, originalAmount: 10000 },
      kind: "within_tolerance",
      rationale: "Extra valve found on site",
    });
  });

  it("the allowance is the smaller of the margin and the cap", () => {
    // 10% of $2,000 = $200 < $1,000
    expect(decide({ newAmount: 2200, originalAmount: 2000 }).kind).toBe("within_tolerance");
    expect(decide({ newAmount: 2200.01, originalAmount: 2000 }).kind).toBe("refused");
    // 10% of $15,000 = $1,500 > $1,000 cap
    expect(decide({ newAmount: 16000, originalAmount: 15000 }).kind).toBe("within_tolerance");
    expect(decide({ newAmount: 16000.01, originalAmount: 15000 }).kind).toBe("refused");
  });

  it("is cumulative: measured against the original amount, not the last accepted edit", () => {
    const result = decide({ acceptedAmount: 10900, newAmount: 11100 });
    expect(result).toMatchObject({ kind: "refused", refusal: { code: "variance_over_margin" } });
  });

  it("works in cents, not floating point", () => {
    expect(decide({ newAmount: 110.1, originalAmount: 100.1 }).kind).toBe("within_tolerance");
  });
});

describe("varianceDecision: refused", () => {
  it("above the margin, naming the margin in the sentence", () => {
    const result = decide({ newAmount: 11540, originalAmount: 10300 });
    expect(result).toEqual({
      figures: { allowance: 1000, deltaAmount: 1240, deltaPercent: 12.04, newAmount: 11540, originalAmount: 10300 },
      kind: "refused",
      refusal: {
        code: "variance_over_margin",
        details: { amount: 11540, originalApprovedAmount: 10300 },
        message: "This is $1,240 (12%) above the approved $10,300 — the allowed margin is 10% up to $1,000. Get it re-approved.",
        status: 422,
      },
    });
  });

  it("when the new total crosses an approval threshold, even within the margin", () => {
    const result = decide({ newAmount: 5200, originalAmount: 4900 });
    expect(result).toMatchObject({ kind: "refused", refusal: { code: "variance_crosses_limit", status: 422 } });
    if (result.kind === "refused") expect(result.refusal.message).toContain("$5,000 approval limit");
  });

  it("when it crosses the director gate", () => {
    const result = decide({ newAmount: 50500, originalAmount: 49800 });
    expect(result).toMatchObject({ kind: "refused", refusal: { code: "variance_crosses_director" } });
  });

  it("an approval at exactly a limit that then rises crosses it", () => {
    expect(decide({ newAmount: 20100, originalAmount: 20000 })).toMatchObject({ refusal: { code: "variance_crosses_limit" } });
  });

  it("without a rationale", () => {
    expect(decide({ request: { attributedTo: MANAGER, rationale: "  " } })).toMatchObject({
      refusal: { code: "variance_rationale_required" },
    });
  });

  it("without a named manager", () => {
    expect(decide({ request: { rationale: "why" } })).toMatchObject({ refusal: { code: "variance_manager_required" } });
  });

  it("when the named manager is the editor", () => {
    const self = { ...MANAGER, userId: EDITOR.userId };
    expect(decide({ request: { attributedTo: self, rationale: "why" } })).toMatchObject({ refusal: { code: "variance_manager_invalid" } });
    const sameEmail = { ...MANAGER, email: "FI@rp.test", userId: 99 };
    expect(decide({ request: { attributedTo: sameEmail, rationale: "why" } })).toMatchObject({ refusal: { code: "variance_manager_invalid" } });
  });

  it("when the named manager can't approve the new total on their own authority", () => {
    const staff = { displayName: "Sam Staff", roles: ["accounts"], userId: 8 };
    const result = decide({ request: { attributedTo: staff, rationale: "why" } });
    expect(result).toMatchObject({ refusal: { code: "variance_manager_invalid" } });
    if (result.kind === "refused") expect(result.refusal.message).toContain("Sam Staff can't approve $10,600");
  });

  it("an admin named as the manager doesn't count (decision 4: admin approves test records only)", () => {
    const admin = { displayName: "Ada Admin", roles: ["admin"], userId: 9 };
    expect(decide({ request: { attributedTo: admin, rationale: "why" } })).toMatchObject({ refusal: { code: "variance_manager_invalid" } });
  });

  it("a new amount that isn't known is never treated as $0", () => {
    expect(decide({ newAmount: null })).toMatchObject({ refusal: { code: "variance_amount_unknown" } });
    expect(decide({ newAmount: Number.NaN })).toMatchObject({ refusal: { code: "variance_amount_unknown" } });
  });
});

describe("varianceDecision: director override (decision 17)", () => {
  const director = { email: "dee@rp.test", roles: ["director"], userId: 1 };

  it("a director overrides a refusal with a reason; the refusal it overrode is kept for the ledger", () => {
    const result = decide({ editor: director, newAmount: 13000, request: { directorOverride: { reason: "Agreed on site" } } });
    expect(result).toMatchObject({
      kind: "director_override",
      overridden: { code: "variance_over_margin" },
      reason: "Agreed on site",
    });
  });

  it("not without a reason, and never for anyone but a director", () => {
    expect(decide({ editor: director, newAmount: 13000, request: { directorOverride: { reason: " " } } }).kind).toBe("refused");
    expect(decide({ newAmount: 13000, request: { directorOverride: { reason: "please" } } }).kind).toBe("refused");
  });
});

describe("formatDollars", () => {
  it("drops cents only when there are none", () => {
    expect(formatDollars(1240)).toBe("$1,240");
    expect(formatDollars(1240.5)).toBe("$1,240.50");
  });
});
