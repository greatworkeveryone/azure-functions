import { assembleSets, evaluate, finalOwner, metricsFor, parseEvalArgs, resolveEvalTarget, trainingRows, type LoggedSetRecord } from "./evaluation";
import { features } from "../__tests__/fixtures/inboundTriageBuilders";

const set = (setId: number, decision: string, ranked: number[], outcomes: { chosen: number; outcome: string; previous?: number | null; rank?: number | null; extra?: boolean }[] = [], over: Partial<LoggedSetRecord> = {}): LoggedSetRecord => ({
  decision, featureSchemaVersion: "triage-features@1", intent: "other", lane: "both",
  items: ranked.map((userId, index) => ({ features: features({ openJobs: userId }), rank: index + 1, score: 50 - index, userId })),
  outcomes: outcomes.map((o) => ({ chosenFeatures: o.extra ? features({ openJobs: 99 }) : null, chosenRank: o.rank ?? null, chosenUserId: o.chosen, outcome: o.outcome as never, previousUserId: o.previous ?? null })),
  rankerVersion: "rules@1", setId, ...over,
});

describe("finalOwner", () => {
  it("is the last outcome's person, with the rank the ranker gave them", () => {
    const s = set(1, "auto", [4, 5], [{ chosen: 4, outcome: "auto_assigned" }, { chosen: 5, outcome: "reassigned", previous: 4 }]);
    expect(finalOwner(s)).toEqual({ rank: 2, userId: 5 });
  });

  it("has no rank for someone the ranker did not list, and no owner before anyone answers", () => {
    expect(finalOwner(set(1, "queued", [4], [{ chosen: 9, outcome: "chose_other" }]))).toEqual({ rank: null, userId: 9 });
    expect(finalOwner(set(1, "queued", [4]))).toBeNull();
  });
});

describe("metricsFor", () => {
  const sets = [
    set(1, "auto", [4, 5], [{ chosen: 4, outcome: "auto_assigned" }]),
    set(2, "auto", [4, 5], [{ chosen: 4, outcome: "auto_assigned" }, { chosen: 5, outcome: "reassigned", previous: 4 }]),
    set(3, "queued", [4, 5, 6, 7], [{ chosen: 7, outcome: "accepted" }]),
    set(4, "queued", [4, 5]),
    set(5, "queued", [4], [{ chosen: 9, outcome: "chose_other" }]),
    set(6, "manual", [], [{ chosen: 9, outcome: "chose_other" }]),
  ];

  it("counts sets by decision and how many were answered", () => {
    expect(metricsFor(sets)).toMatchObject({ answered: 5, auto: 2, manual: 1, queued: 3, sets: 6 });
  });

  it("measures hit@1, hit@3 and mrr against the final owner, an unranked owner counting as a miss", () => {
    const m = metricsFor(sets.filter((s) => s.decision !== "manual"));
    // answered: s1 rank1, s2 rank2, s3 rank4, s5 unranked
    expect(m.hitAt["1"]).toBeCloseTo(1 / 4);
    expect(m.hitAt["3"]).toBeCloseTo(2 / 4);
    expect(m.mrr).toBeCloseTo((1 + 0.5 + 0.25 + 0) / 4);
  });

  it("measures how many automatic assignments were left alone and how many queued emails were answered", () => {
    const m = metricsFor(sets);
    expect(m.autoKept).toBeCloseTo(1 / 2);
    expect(m.queuePicked).toBeCloseTo(2 / 3);
  });

  it("says n/a, not zero, when there is nothing to divide", () => {
    expect(metricsFor([])).toMatchObject({ autoKept: null, hitAt: { "1": null, "3": null }, mrr: null, queuePicked: null, sets: 0 });
  });
});

describe("evaluate", () => {
  it("reports per ranker version and schema version, never mixing them, and leaves manual sets out", () => {
    const groups = evaluate([set(1, "auto", [4], [{ chosen: 4, outcome: "auto_assigned" }]), set(2, "auto", [4], [{ chosen: 4, outcome: "auto_assigned" }], { rankerVersion: "learned@1" }), set(3, "manual", [], [{ chosen: 4, outcome: "chose_other" }]), set(4, "auto", [4], [], { featureSchemaVersion: "triage-features@2" })]);
    expect(groups.map((g) => `${g.rankerVersion} ${g.featureSchemaVersion} ${g.overall.sets}`)).toEqual(["rules@1 triage-features@1 1", "learned@1 triage-features@1 1", "rules@1 triage-features@2 1"]);
  });
});

describe("trainingRows", () => {
  it("writes a row per ranked person per answered set, labelled by who became the owner, and nothing for unanswered sets", () => {
    const rows = trainingRows([set(1, "queued", [4, 5], [{ chosen: 5, outcome: "accepted", rank: 2 }]), set(2, "queued", [4, 5])]);
    expect(rows.map((r) => [r.setId, r.userId, r.rank, r.label])).toEqual([[1, 4, 1, false], [1, 5, 2, true]]);
  });

  it("adds the owner's own row, with their captured features, when they were not ranked", () => {
    const rows = trainingRows([set(1, "queued", [4], [{ chosen: 9, outcome: "chose_other", extra: true }])]);
    expect(rows.map((r) => [r.userId, r.rank, r.label])).toEqual([[4, 1, false], [9, null, true]]);
    expect(rows[1].features.openJobs).toBe(99);
  });
});

describe("assembleSets", () => {
  it("joins the three tables' rows, parsing the features", () => {
    const [joined] = assembleSets(
      [{ Decision: "queued", FeatureSchemaVersion: "triage-features@1", Intent: "other", Lane: "both", RankerVersion: "rules@1", SetId: 1 }],
      [{ CandidateUserId: 4, FeaturesJson: JSON.stringify(features({ openJobs: 3 })), Rank: 1, Score: 15, SetId: 1 }, { CandidateUserId: 4, FeaturesJson: "{}", Rank: 1, Score: 1, SetId: 2 }],
      [{ ChosenFeaturesJson: null, ChosenRank: 1, ChosenUserId: 4, Outcome: "accepted", PreviousUserId: null, SetId: 1 }],
    );
    expect(joined.items).toHaveLength(1);
    expect(joined.items[0].features.openJobs).toBe(3);
    expect(joined.outcomes).toEqual([{ chosenFeatures: null, chosenRank: 1, chosenUserId: 4, outcome: "accepted", previousUserId: null }]);
  });
});

describe("the command line", () => {
  it("reads its options, and refuses unknown ones and a bad date", () => {
    expect(parseEvalArgs(["--json", "--include-test", "--since", "2026-10-01", "--ranker", "rules@1", "--export", "r.jsonl"])).toMatchObject({ export: "r.jsonl", includeTest: true, json: true, ranker: "rules@1", since: "2026-10-01" });
    expect(() => parseEvalArgs(["--replay", "x"])).toThrow("Unknown option --replay");
    expect(() => parseEvalArgs(["--since", "yesterday"])).toThrow("YYYY-MM-DD");
    expect(() => parseEvalArgs(["--ranker"])).toThrow("needs a value");
  });

  it("reads the local review database unless --allow-remote says otherwise", () => {
    expect(resolveEvalTarget(parseEvalArgs([]))).toMatchObject({ database: "floorplan_review", isLocal: true });
    expect(() => resolveEvalTarget(parseEvalArgs(["--target", "prod.database.windows.net/floorplan"]))).toThrow();
  });
});
