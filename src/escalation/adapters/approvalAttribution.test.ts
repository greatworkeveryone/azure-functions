import { describe, expect, it } from "@jest/globals";
import { approvalAttributionAdapter, attributionSubjectId, disputedPolicy, noticePolicy, parseAttributionSubjectId } from "./approvalAttribution";

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
