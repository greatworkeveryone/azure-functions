import type { AuthorityFacts } from "./approvalAuthority";
import { committedTotal, purchaseOrderSpendRefusal, type PoSpendInput } from "./purchaseOrderSpend";

const FACTS: AuthorityFacts = {
  directorThreshold: 50000,
  isResidence: false,
  limits: [
    { limit: 20000, role: "facilities_manager" },
    { limit: 5000, role: "accounts_manager" },
    { limit: 50000, role: "cfo" },
  ],
  residenceApprovers: [],
  residenceDirectorFallback: true,
  today: "2026-11-21",
};

const base = (over: Partial<PoSpendInput> = {}): PoSpendInput => ({
  actor: { roles: ["facilities_manager"], userId: 7 },
  approvedQuote: null,
  buildingId: 1,
  isContract: true,
  isTest: false,
  otherCommitted: 0,
  poContractorId: 3,
  stage: "send",
  thisAmount: 1000,
  ...over,
});
const code = (over: Partial<PoSpendInput>) => purchaseOrderSpendRefusal(base(over), FACTS)?.code ?? null;

describe("contract job: the person's own limit, summed across the job (JOB-20, SECA-03)", () => {
  it("lets a purchase order within the limit through", () => {
    expect(code({ thisAmount: 19000 })).toBeNull();
  });
  it("refuses one over the limit and says the figure and who can", () => {
    const refusal = purchaseOrderSpendRefusal(base({ thisAmount: 30000 }), FACTS)!;
    expect(refusal.code).toBe("po_over_authority");
    expect(refusal.message).toContain("$30,000");
    expect(refusal.message).toContain("$20,000");
    expect(refusal.message).toMatch(/the CFO, a director/);
    // Above the director threshold only a director can.
    expect(purchaseOrderSpendRefusal(base({ thisAmount: 90000 }), FACTS)!.message).toMatch(/Ask a director/);
  });
  it("sums the job's other purchase orders: three at 8,000 pass singly and fail together", () => {
    expect(code({ otherCommitted: 0, thisAmount: 8000 })).toBeNull();
    expect(code({ otherCommitted: 16000, thisAmount: 8000 })).toBe("po_over_authority");
  });
  it("a director commits any amount; a CFO up to the director threshold", () => {
    expect(code({ actor: { roles: ["director"], userId: 1 }, thisAmount: 400000 })).toBeNull();
    expect(code({ actor: { roles: ["cfo"], userId: 2 }, thisAmount: 40000 })).toBeNull();
    expect(code({ actor: { roles: ["cfo"], userId: 2 }, thisAmount: 60000 })).toBe("po_over_authority");
  });
  it("admin counts for nothing on a real record, and may on a test one", () => {
    expect(code({ actor: { roles: ["admin"], userId: 9 }, thisAmount: 100 })).toBe("po_admin_test_only");
    const withAdminRow = { ...FACTS, limits: [...FACTS.limits, { limit: 1000, role: "admin" }] };
    expect(purchaseOrderSpendRefusal(base({ actor: { roles: ["admin"], userId: 9 }, isTest: true, thisAmount: 100 }), withAdminRow)).toBeNull();
  });
  it("plain accounts may draft but not send", () => {
    expect(code({ actor: { roles: ["accounts"], userId: 4 }, stage: "create" })).toBeNull();
    expect(code({ actor: { roles: ["accounts"], userId: 4 }, stage: "send" })).toBe("po_not_authorised");
  });
  it("an unknown amount is not waved through on send", () => {
    expect(code({ thisAmount: null })).toBe("po_over_authority");
  });
});

describe("job with an approved quote", () => {
  const quote = { amount: 5000, contractorId: 3 };
  it("accepts the quoted contractor, whatever the sender's own limit (the quote approval applied it)", () => {
    expect(code({ approvedQuote: quote, thisAmount: 5000, actor: { roles: ["accounts_manager"], userId: 5 } })).toBeNull();
  });
  it("refuses another contractor", () => {
    expect(code({ approvedQuote: quote, poContractorId: 4 })).toBe("po_contractor_not_quoted");
    expect(code({ approvedQuote: quote, poContractorId: null })).toBe("po_contractor_not_quoted");
  });
  it("cannot compare when the quote names no contractor id", () => {
    expect(code({ approvedQuote: { amount: 5000, contractorId: null }, poContractorId: 4 })).toBeNull();
  });
  it("admin is still refused on a real record", () => {
    expect(code({ actor: { roles: ["admin"], userId: 9 }, approvedQuote: quote })).toBe("po_admin_test_only");
  });
});

describe("committedTotal", () => {
  it("adds this order to the others, in cents", () => {
    expect(committedTotal({ otherCommitted: 0.1, thisAmount: 0.2 })).toBe(0.3);
    expect(committedTotal({ otherCommitted: 5, thisAmount: null })).toBeNull();
  });
});
