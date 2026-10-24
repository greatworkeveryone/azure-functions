import { componentsFor, RULES_V1_WEIGHTS, rulesRanker } from "./rulesRanker";
import { candidate, context, features } from "../__tests__/fixtures/inboundTriageBuilders";

const w = RULES_V1_WEIGHTS;
const total = (over: Parameters<typeof features>[0], ctx = context()) => componentsFor(features(over), ctx).reduce((sum, component) => sum + component.points, 0);

describe("rules@1 arithmetic", () => {
  it("scores only the role for someone with no evidence", () => {
    expect(total({})).toBe(w.roleFit.lane_staff);
    expect(total({ roleFit: "lane_manager" })).toBe(w.roleFit.lane_manager);
    expect(total({ roleFit: "none" })).toBe(0);
  });

  it("weighs a deliberate act above history above role", () => {
    expect(w.sentLinkedSend).toBeGreaterThan(w.ownsOpenJobForTenancy);
    expect(w.ownsNamedJob).toBeGreaterThan(w.ownsOpenJobForTenancy);
    expect(w.ownsOpenJobForTenancy).toBeGreaterThan(w.roleFit.lane_staff);
  });

  it("adds each piece of evidence once", () => {
    expect(total({ sentLinkedSend: true })).toBe(w.roleFit.lane_staff + w.sentLinkedSend);
    expect(total({ ownsNamedJob: true }, context({ matchedJobId: 77 }))).toBe(w.roleFit.lane_staff + w.ownsNamedJob);
    expect(total({ ownsOpenJobForTenancy: true, ownsOpenJobHere: true })).toBe(w.roleFit.lane_staff + w.ownsOpenJobForTenancy + w.ownsOpenJobHere);
  });

  it("caps recent jobs here, and counts other-category jobs at the weaker rate", () => {
    expect(total({ jobsHere90d: 20, jobsHereCategory90d: 20 })).toBe(w.roleFit.lane_staff + w.maxJobsHereCategory * w.perJobHereCategory);
    expect(total({ jobsHere90d: 3, jobsHereCategory90d: 1 })).toBe(w.roleFit.lane_staff + w.perJobHereCategory + 2 * w.perJobHere);
  });

  it("claims no category jobs when the email has no category", () => {
    const texts = componentsFor(features({ jobsHere90d: 2, jobsHereCategory90d: 0 }), context({ category: null })).map((component) => component.text);
    expect(texts).toContain("2 jobs at Frogmore House in the last 90 days");
  });

  it("lowers the score a little for a heavy open workload and shows it as a caution", () => {
    const heavy = componentsFor(features({ openJobs: 14 }), context());
    expect(heavy.find((component) => component.caution)).toMatchObject({ points: -4, text: "Already has 14 open jobs" });
    expect(total({ openJobs: 100 })).toBe(w.roleFit.lane_staff - w.maxBusyPenalty);
    expect(total({ openJobs: 10 })).toBe(w.roleFit.lane_staff);
  });
});

describe("rules@1 ranking and reasons", () => {
  it("ranks everyone, best first, and says why in plain sentences", () => {
    const ranked = rulesRanker.rank(
      [candidate(1, "Fay", { roleFit: "lane_staff" }), candidate(2, "Gus", { ownsNamedJob: true, ownsOpenJobHere: true, jobsHere90d: 2, jobsHereCategory90d: 2 }), candidate(3, "Mo", { roleFit: "lane_manager" })],
      context({ matchedJobId: 77 }),
    );
    expect(ranked.map((item) => item.name)).toEqual(["Gus", "Fay", "Mo"]);
    expect(ranked[0].reasons.map((reason) => reason.text)).toEqual([
      "Is assigned job #77, which this email names",
      "Works on maintenance",
      "Has an open job at Frogmore House",
      "2 Electrical jobs at Frogmore House in the last 90 days",
    ]);
    expect(rulesRanker.version).toBe("rules@1");
  });

  it("names the tenancy and the lane in its sentences", () => {
    const [first] = rulesRanker.rank([candidate(1, "Ann", { ownsOpenJobForTenancy: true, roleFit: "lane_manager" }, "accounts_manager")], context({ lane: "accounts", tenancyName: "Acme Pty Ltd" }));
    expect(first.reasons.map((reason) => reason.text)).toEqual(["Has an open job for Acme Pty Ltd", "Manages accounts"]);
  });

  it("breaks a tie by less open work, then name, so load order never decides", () => {
    const a = candidate(1, "Zed", { openJobs: 2 });
    const b = candidate(2, "Amy", { openJobs: 2 });
    const c = candidate(3, "Bea", { openJobs: 0 });
    expect(rulesRanker.rank([a, b, c], context()).map((item) => item.name)).toEqual(["Bea", "Amy", "Zed"]);
    expect(rulesRanker.rank([c, b, a], context()).map((item) => item.name)).toEqual(["Bea", "Amy", "Zed"]);
  });

  it("returns nothing for nobody", () => {
    expect(rulesRanker.rank([], context())).toEqual([]);
  });

  it("logs the features it saw, untouched", () => {
    const given = candidate(1, "Fay", { jobsHere90d: 4 });
    expect(rulesRanker.rank([given], context())[0].features).toBe(given.features);
  });
});
