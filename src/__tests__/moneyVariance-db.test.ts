/// <reference types="jest" />
// R13 in the database half (review 117 mutants B6, B7, B15): a fake that runs
// the WHERE clauses the code really sends over rows held in memory, so dropping
// a clause lets the wrong row through and the test fails.

jest.mock("../db", () => ({ executeQuery: jest.fn() }));
jest.mock("../approval-limits-db", () => ({ getCachedApprovalLimits: jest.fn() }));

const db = require("../db") as { executeQuery: jest.Mock };
const limitsDb = require("../approval-limits-db") as { getCachedApprovalLimits: jest.Mock };
const { acceptedVarianceAmount, checkVariance } = require("../moneyVariance-db") as typeof import("../moneyVariance-db");
const { listUnansweredAttributions } = require("../escalation/adapters/approvalAttribution") as typeof import("../escalation/adapters/approvalAttribution");

interface VarianceRow { AnsweredAt: Date | null; AttributedToUserID: number | null; Disputed: boolean | null; DirectorOverride: boolean; JobID: number; NewAmount: number; QuoteID: number | null; SubjectID: number; SubjectType: string; VarianceID: number }
interface QuoteRow { ApprovalAttributedToUserID: number | null; AttributionAnsweredAt: Date | null; JobID: number; QuoteID: number; Status: string }

let variances: VarianceRow[] = [];
let quotes: QuoteRow[] = [];
let approvedQuote: { Amount: number; QuoteID: number } | null = null;
/** Every quote on the job, for a JOIN that isn't on Jobs.ApprovedQuoteID (B6a). */
let jobQuotes: { Amount: number; QuoteID: number }[] = [];

const variance = (over: Partial<VarianceRow>): VarianceRow => ({
  AnsweredAt: null, AttributedToUserID: 30, DirectorOverride: false, Disputed: null, JobID: 9, NewAmount: 10600, QuoteID: 70,
  SubjectID: 99, SubjectType: "purchase_order", VarianceID: 1, ...over,
});

beforeEach(() => {
  variances = [];
  quotes = [];
  approvedQuote = { Amount: 10000, QuoteID: 70 };
  jobQuotes = [];
  limitsDb.getCachedApprovalLimits.mockResolvedValue([
    { MaxApprovalAmount: 20000, RoleName: "facilities_manager" },
    { MaxApprovalAmount: null, RoleName: "director" },
  ]);
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string, params: { name: string; value: unknown }[] = []) => {
    const p = Object.fromEntries(params.map((x) => [x.name, x.value]));
    if (/FROM Jobs j INNER JOIN Quotes q/.test(sql)) {
      if (!/ON q\.QuoteID = j\.ApprovedQuoteID/.test(sql)) return [...jobQuotes, ...(approvedQuote ? [approvedQuote] : [])];
      return approvedQuote ? [approvedQuote] : [];
    }
    if (/FROM Quotes q\s/.test(sql)) {
      const quote = quotes.find((r) => r.QuoteID === p.Id);
      return quote ? [{ ...quote, Amount: 4500, ApprovedBy: "Fi", BuildingID: 5, QuoteNumber: "QT-1" }] : [];
    }
    if (/FROM dbo\.ApprovalFacts/.test(sql)) return [{ FactKey: "po_variance_margin_percent", FactValue: 10 }, { FactKey: "po_variance_cap", FactValue: 1000 }];
    if (/MAX\(NewAmount\)/.test(sql)) {
      const hits = variances.filter(
        (v) =>
          (!/SubjectID = @Id/.test(sql) || (v.SubjectType === "purchase_order" && v.SubjectID === p.Id)) &&
          (!/JobID = @Id/.test(sql) || v.JobID === p.Id) &&
          (!/QuoteID = @QuoteID/.test(sql) || v.QuoteID === p.QuoteID) &&
          (!/ISNULL\(Disputed, 0\) = 0/.test(sql) || !v.Disputed),
      );
      return [{ Accepted: hits.length ? Math.max(...hits.map((v) => v.NewAmount)) : null }];
    }
    if (/UNION ALL/.test(sql)) {
      const q = quotes
        .filter(
          (r) =>
            r.ApprovalAttributedToUserID !== null &&
            r.AttributionAnsweredAt === null &&
            (!/Status IN \(N'approved', N'completed'\)/.test(sql) || ["approved", "completed"].includes(r.Status)),
        )
        .map((r) => ({ Id: r.QuoteID, JobID: r.JobID, Kind: "quote", UserId: r.ApprovalAttributedToUserID }));
      const v = variances
        .filter((r) => r.AttributedToUserID !== null && r.AnsweredAt === null && (!/DirectorOverride = 0/.test(sql) || !r.DirectorOverride))
        .map((r) => ({ Id: r.VarianceID, JobID: r.JobID, Kind: "variance", UserId: r.AttributedToUserID }));
      return [...q, ...v];
    }
    return [];
  });
});

describe("acceptedVarianceAmount", () => {
  it("B6: a rise accepted against a quote since deselected covers nothing under the new quote", async () => {
    variances = [variance({ NewAmount: 21000, QuoteID: 70 })];
    expect(await acceptedVarianceAmount({} as never, { purchaseOrderId: 99 }, 70)).toBe(21000);
    expect(await acceptedVarianceAmount({} as never, { purchaseOrderId: 99 }, 71)).toBeNull();
    expect(await acceptedVarianceAmount({} as never, { jobId: 9 }, 71)).toBeNull();
    expect(await acceptedVarianceAmount({} as never, { purchaseOrderId: 99 }, null)).toBeNull();
  });

  it("B7: a disputed rise doesn't cover the next send or invoice", async () => {
    variances = [variance({ Disputed: true, NewAmount: 10600 }), variance({ NewAmount: 10300, VarianceID: 2 })];
    expect(await acceptedVarianceAmount({} as never, { purchaseOrderId: 99 }, 70)).toBe(10300);
  });
});

describe("checkVariance", () => {
  const editor = { email: "fi@rp.test", roles: ["facilities_manager"], userId: 3 };

  it("B6, end to end: a $21,000 send is checked again once the $20,000 quote is replaced by a $15,000 one", async () => {
    variances = [variance({ NewAmount: 21000, QuoteID: 70 })];
    approvedQuote = { Amount: 15000, QuoteID: 71 };
    const result = await checkVariance({} as never, {
      accepted: { purchaseOrderId: 99 }, body: null, buildingId: 5, editor, jobId: 9, newAmount: 21000, subject: "purchase_order",
    });
    expect(result).toMatchObject({ decision: { kind: "refused", refusal: { code: "variance_over_margin" } }, quoteId: 71 });
  });

  it("B7, end to end: a send at a disputed amount is checked again", async () => {
    variances = [variance({ Disputed: true, NewAmount: 10600 })];
    const result = await checkVariance({} as never, {
      accepted: { purchaseOrderId: 99 }, body: null, buildingId: 5, editor, jobId: 9, newAmount: 10600, subject: "purchase_order",
    });
    expect(result.decision.kind).toBe("refused");
  });

  it("an amount accepted under the current quote goes through", async () => {
    variances = [variance({ NewAmount: 10600 })];
    const result = await checkVariance({} as never, {
      accepted: { purchaseOrderId: 99 }, body: null, buildingId: 5, editor, jobId: 9, newAmount: 10600, subject: "purchase_order",
    });
    expect(result).toEqual({ decision: { kind: "no_variance" }, originalAmount: 10000, quoteId: 70 });
  });
});

describe("checkVariance: which quote it measures against", () => {
  it("B6a: the job's APPROVED quote, never another quote on the job", async () => {
    jobQuotes = [{ Amount: 30000, QuoteID: 69 }];
    approvedQuote = { Amount: 15000, QuoteID: 71 };
    const result = await checkVariance({} as never, {
      accepted: { purchaseOrderId: 99 }, body: null, buildingId: 5, editor: { roles: ["facilities_manager"], userId: 3 }, jobId: 9, newAmount: 20000, subject: "purchase_order",
    });
    expect(result).toMatchObject({ decision: { kind: "refused" }, originalAmount: 15000, quoteId: 71 });
  });
});

describe("N7: completing the work doesn't end the named manager's question", () => {
  const { approvalAttributionAdapter } = require("../escalation/adapters/approvalAttribution") as typeof import("../escalation/adapters/approvalAttribution");
  const ref = { policyKey: "quote.attribution_notice", subjectId: "quote:7@9", subjectType: "approval_attribution" };

  it.each([["approved", true], ["completed", true], ["pending", false], ["rejected", false]])("a quote that is %s: notice live = %p", async (status, live) => {
    quotes = [{ ApprovalAttributedToUserID: 30, AttributionAnsweredAt: null, JobID: 9, QuoteID: 7, Status: status }];
    expect(await approvalAttributionAdapter.isConditionActive({} as never, ref, new Date())).toBe(live);
    expect((await listUnansweredAttributions({} as never)).length).toBe(live ? 1 : 0);
  });
});

describe("listUnansweredAttributions", () => {
  it("B15: never a director's override, and never a quote that is no longer approved", async () => {
    variances = [variance({ VarianceID: 1 }), variance({ DirectorOverride: true, VarianceID: 2 })];
    quotes = [
      { ApprovalAttributedToUserID: 30, AttributionAnsweredAt: null, JobID: 9, QuoteID: 7, Status: "approved" },
      { ApprovalAttributedToUserID: 30, AttributionAnsweredAt: null, JobID: 9, QuoteID: 8, Status: "pending" },
    ];
    const listed = await listUnansweredAttributions({} as never);
    expect(listed.map((row) => `${row.ref.kind}:${row.ref.id}`)).toEqual(["quote:7", "variance:1"]);
  });
});
