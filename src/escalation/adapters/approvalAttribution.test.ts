import { describe, expect, it } from "@jest/globals";
import {
  approvalAttributionAdapter,
  attributionSubjectId,
  attributionSummary,
  disputeSummary,
  disputedPolicy,
  noticePolicy,
  parseAttributionSubjectId,
  type AttributionRecord,
} from "./approvalAttribution";

const record = (over: Partial<AttributionRecord> = {}): AttributionRecord => ({
  amount: 4500, answeredAt: null, attributedToName: "Mo Manager", attributedToUserId: 30, buildingId: 5, byName: "Fi Facilities",
  contractorId: 3, contractorName: "Acme", current: true, disputed: false, jobId: 12, label: "Quote QT-9-1", originalAmount: null,
  rationale: null, ref: { id: 7, jobId: 12, kind: "quote" }, subjectId: 7, subjectType: "quote", ...over,
});

describe("approval_attribution adapter", () => {
  it("round-trips its subject ids and links to the job", () => {
    const id = attributionSubjectId({ id: 7, jobId: 9, kind: "quote" });
    expect(id).toBe("quote:7@9");
    expect(parseAttributionSubjectId(id)).toEqual({ id: 7, jobId: 9, kind: "quote" });
    expect(parseAttributionSubjectId("variance:4@12")).toEqual({ id: 4, jobId: 12, kind: "variance" });
    expect(parseAttributionSubjectId("quote:x@9")).toBeNull();
    expect(approvalAttributionAdapter.deepLink("variance:4@12")).toBe("/jobs?jobId=12");
  });

  it("names the four policies PLAN §3.7 gives it", () => {
    expect([noticePolicy("quote"), disputedPolicy("quote"), noticePolicy("variance"), disputedPolicy("variance")]).toEqual([
      "quote.attribution_notice",
      "quote.attribution_disputed",
      "po.variance_notice",
      "po.variance_disputed",
    ]);
  });

  it("a dispute stays open until a person resolves it", async () => {
    const active = await approvalAttributionAdapter.isConditionActive({} as never, { policyKey: "quote.attribution_disputed", subjectId: "quote:7@9", subjectType: "approval_attribution" }, new Date());
    expect(active).toBe(true);
  });
});

describe("what the manager is shown", () => {
  it("names the amount on a quote, and the original and the reason on a rise", () => {
    expect(attributionSummary(record())).toBe("Job #12 · Quote QT-9-1 · $4,500 · approved by Fi Facilities, agreed with Mo Manager");
    const rise = record({
      amount: 10600, label: "Purchase order #99", originalAmount: 10000, rationale: "Extra valve", ref: { id: 4, jobId: 12, kind: "variance" },
    });
    expect(attributionSummary(rise)).toBe(
      "Job #12 · Purchase order #99 · $10,600, up from the approved $10,000 · raised within the margin by Fi Facilities, agreed with Mo Manager · Extra valve",
    );
  });

  it("a dispute says the quote is still approved and what to do", () => {
    expect(disputeSummary(record(), "Mo Manager")).toBe(
      "Job #12 · Quote QT-9-1 · $4,500 · approved by Fi Facilities, agreed with Mo Manager — Mo Manager didn't agree to it. The quote is still approved: deselect it or confirm it.",
    );
  });
});
