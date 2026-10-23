import {
  assembleSets,
  DEFAULT_EVAL_TARGET,
  evaluate,
  isLocalServer,
  metricsFor,
  parseEvalArgs,
  replay,
  resolveEvalTarget,
  trainingRows,
  type LoggedSetItem,
  type LoggedSetOutcome,
  type LoggedSetRecord,
} from "./evaluation";
import { rulesRanker } from "./rulesRanker";
import type { Candidate, FeatureVector, Ranker, ScoredCandidate } from "./types";

const features = (patch: Partial<FeatureVector> = {}): FeatureVector => ({
  assignedToBuilding: false,
  certificateDaysToExpiry: 100,
  certificateStatus: "valid",
  daysSinceLastJobHere: null,
  jobsHere12m: 0,
  jobsTrade12m: 0,
  medianDaysToComplete12m: null,
  quoteAcceptanceRate12m: null,
  quotesAccepted12m: 0,
  quotesDecided12m: 0,
  regionMatch: null,
  tradeCovered: null,
  ...patch,
});

const items = (...ids: number[]): LoggedSetItem[] => ids.map((contractorId, index) => ({ contractorId, features: features({ jobsHere12m: ids.length - index }), rank: index + 1, score: 100 - index }));
const suggested = (id: number, rank: number): LoggedSetOutcome => ({ chosenContractorId: id, chosenFeatures: null, chosenRank: rank, outcome: "chose_suggested" });
const other = (id: number, captured = true): LoggedSetOutcome => ({ chosenContractorId: id, chosenFeatures: captured ? features({ jobsTrade12m: 2 }) : null, chosenRank: null, outcome: "chose_other" });
const dismissed: LoggedSetOutcome = { chosenContractorId: null, chosenFeatures: null, chosenRank: null, outcome: "dismissed" };

function set(setId: number, patch: Partial<LoggedSetRecord>): LoggedSetRecord {
  return {
    buildingId: 10,
    candidateCount: 3,
    context: "quote_request",
    createdAt: "2026-10-23T01:00:00.000Z",
    featureSchemaVersion: "cs-features@1",
    isTest: false,
    items: [],
    jobId: setId,
    outcomes: [],
    rankerVersion: "rules@1",
    setId,
    trade: "Electrical",
    ...patch,
  };
}

// Contractors: A=1 B=2 C=3 D=4 E=5; chosen without being suggested: X=90 Y=91 Z=92.
const FIXTURE: LoggedSetRecord[] = [
  set(1, { items: items(1, 2, 3), outcomes: [suggested(1, 1)] }),
  set(2, { items: items(1, 2, 3), outcomes: [suggested(3, 3)] }),
  set(3, { context: "assign", items: items(1, 2), outcomes: [other(90)] }),
  set(4, { items: [], outcomes: [other(91, false)] }),
  set(5, { items: items(1, 2) }),
  set(6, { context: "assign", items: items(1, 2, 3, 4, 5), outcomes: [dismissed] }),
  set(7, { items: items(1, 2, 3), outcomes: [suggested(2, 2), other(92)] }),
  set(8, { items: items(1, 2), rankerVersion: "stand-in@1" }),
  set(9, { items: items(1, 2), outcomes: [suggested(1, 1)], rankerVersion: "stand-in@1" }),
];
const RULES = FIXTURE.filter((s) => s.rankerVersion === "rules@1");

describe("metricsFor, by hand", () => {
  const m = metricsFor(RULES);

  it("counts sets, answers, dismissals and choices", () => {
    expect(m.counts).toEqual({
      answered: 5,
      choices: 6,
      choicesOther: 3,
      choicesSuggested: 3,
      dismissed: 1,
      sets: 7,
      setsEmpty: 1,
      setsWithSuggestions: 6,
      unanswered: 1,
    });
  });

  it("measures hit@1, hit@3 and hit@5 over answered sets, counting an empty suggestion list as a miss", () => {
    // best chosen rank per answered set: 1, 3, none, none, 2
    expect(m.hitAt).toEqual({ "1": 0.2, "3": 0.6, "5": 0.6 });
  });

  it("takes the best-ranked of several chosen contractors in a set", () => {
    expect(metricsFor([set(7, { items: items(1, 2, 3), outcomes: [suggested(3, 3), suggested(2, 2)] })]).hitAt["3"]).toBe(1);
    expect(metricsFor([set(7, { items: items(1, 2, 3), outcomes: [suggested(3, 3), suggested(2, 2)] })]).hitAt["1"]).toBe(0);
  });

  it("reports the mean reciprocal rank", () => {
    expect(m.mrr).toBeCloseTo((1 + 1 / 3 + 0 + 0 + 1 / 2) / 5, 4);
  });

  it("reports coverage as the sets that suggested anyone, of all sets", () => {
    expect(m.coverage).toBeCloseTo(6 / 7, 4);
  });

  it("is null, not zero, when there is nothing to measure", () => {
    const none = metricsFor([set(1, { items: items(1) })]);
    expect(none.hitAt).toEqual({ "1": null, "3": null, "5": null });
    expect(none.mrr).toBeNull();
    expect(metricsFor([]).coverage).toBeNull();
  });
});

describe("evaluate", () => {
  const groups = evaluate(FIXTURE);

  it("keeps each ranker version apart", () => {
    expect(groups.map((g) => g.rankerVersion)).toEqual(["rules@1", "stand-in@1"]);
    expect(groups[0].overall.counts.sets).toBe(7);
    expect(groups[1].overall.counts.sets).toBe(2);
    expect(groups[1].overall.hitAt["1"]).toBe(1);
  });

  it("keeps feature schema versions apart as well", () => {
    const split = evaluate([...RULES, set(10, { featureSchemaVersion: "cs-features@2", items: items(1), outcomes: [suggested(1, 1)] })]);
    expect(split.map((g) => `${g.rankerVersion}/${g.featureSchemaVersion}`)).toEqual(["rules@1/cs-features@1", "rules@1/cs-features@2"]);
  });

  it("breaks each group down by context", () => {
    const rules = groups[0];
    expect(Object.keys(rules.byContext)).toEqual(["assign", "quote_request"]);
    expect(rules.byContext.quote_request?.counts.answered).toBe(4);
    expect(rules.byContext.quote_request?.hitAt).toEqual({ "1": 0.25, "3": 0.75, "5": 0.75 });
    expect(rules.byContext.assign?.hitAt["1"]).toBe(0);
    expect(rules.byContext.assign?.coverage).toBe(1);
  });
});

describe("trainingRows", () => {
  const rows = trainingRows(RULES);
  const of = (setId: number) => rows.filter((row) => row.setId === setId);

  it("labels each suggested contractor by what the person did", () => {
    expect(of(1).map((row) => [row.contractorId, row.label, row.rank])).toEqual([[1, 1, 1], [2, 0, 2], [3, 0, 3]]);
    expect(of(2).map((row) => row.label)).toEqual([0, 0, 1]);
  });

  it("adds a positive for someone chosen without being suggested, when their features were captured", () => {
    const extra = of(3).filter((row) => !row.suggested);
    expect(extra).toHaveLength(1);
    expect(extra[0]).toMatchObject({ contractorId: 90, features: features({ jobsTrade12m: 2 }), label: 1, rank: null, score: null });
    expect(of(4)).toEqual([]);
  });

  it("labels everything shown in a dismissed set as not chosen", () => {
    expect(of(6)).toHaveLength(5);
    expect(of(6).every((row) => row.label === 0 && row.setAnswer === "dismissed")).toBe(true);
    expect(of(1).every((row) => row.setAnswer === "chose")).toBe(true);
  });

  it("leaves out a set nobody answered", () => {
    expect(of(5)).toEqual([]);
  });

  it("carries the versions and context a trainer must key on", () => {
    expect(of(1)[0]).toMatchObject({ context: "quote_request", featureSchemaVersion: "cs-features@1", rankerVersion: "rules@1", trade: "Electrical" });
    expect(rows).toHaveLength(3 + 3 + 3 + 5 + 4);
  });
});

describe("replay", () => {
  const byIdDescending: Ranker = {
    rank: (candidates: readonly Candidate[]): ScoredCandidate[] =>
      [...candidates].sort((a, b) => b.contractorId - a.contractorId).map((c) => ({ ...c, reasons: [], score: c.contractorId })),
    version: "by-id-desc@1",
  };

  it("re-ranks the answered sets with another ranker, beside the logged result on the same sets", async () => {
    const report = await replay(RULES, byIdDescending);
    expect(report.sets).toBe(5);
    expect(report.baseline.hitAt).toEqual({ "1": 0.2, "3": 0.6, "5": 0.6 });
    // replayed best ranks: 3, 1, 1, none, 1
    expect(report.replayed.hitAt).toEqual({ "1": 0.6, "3": 0.8, "5": 0.8 });
    expect(report.replayed.mrr).toBeCloseTo((1 / 3 + 1 + 1 + 0 + 1) / 5, 4);
  });

  it("reproduces the logged order when the ranker is the one that made it: the features are logged exactly enough", async () => {
    const candidates: Candidate[] = [
      { contractorId: 1, features: features({ jobsHere12m: 1, tradeCovered: true }), name: "Alpha" },
      { contractorId: 2, features: features({ assignedToBuilding: true }), name: "Beta" },
      { contractorId: 3, features: features({ jobsHere12m: 4, jobsTrade12m: 2 }), name: "Gamma" },
    ];
    const ranked = rulesRanker.rank(candidates, { buildingId: 10, buildingRegion: null, context: "assign", jobId: 5, today: "2026-10-23", trade: "Electrical" });
    const logged = set(1, {
      context: "assign",
      items: ranked.map((item, index) => ({ contractorId: item.contractorId, features: item.features, rank: index + 1, score: item.score })),
      outcomes: [suggested(ranked[1].contractorId, 2)],
    });
    const report = await replay([logged], rulesRanker);
    expect(report.replayed.hitAt).toEqual(report.baseline.hitAt);
    expect(report.replayed.mrr).toBe(report.baseline.mrr);
  });
});

describe("assembleSets", () => {
  it("joins the three tables' rows and drops a row whose JSON no longer parses", () => {
    const sets = assembleSets(
      [{ BuildingId: 10, CandidateCount: 2, Context: "assign", CreatedAt: new Date("2026-10-23T01:00:00Z"), FeatureSchemaVersion: "cs-features@1", IsTest: 1, JobId: null, RankerVersion: "rules@1", SetId: 4, Trade: null }],
      [
        { ContractorId: 8, FeaturesJson: JSON.stringify(features()), Rank: 2, Score: 10, SetId: 4 },
        { ContractorId: 7, FeaturesJson: JSON.stringify(features()), Rank: 1, Score: 20, SetId: 4 },
        { ContractorId: 9, FeaturesJson: "{not json", Rank: 3, Score: 1, SetId: 4 },
      ],
      [{ ChosenContractorId: 7, ChosenFeaturesJson: null, ChosenRank: 1, Outcome: "chose_suggested", SetId: 4 }],
    );
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ createdAt: "2026-10-23T01:00:00.000Z", isTest: true, jobId: null, setId: 4, trade: null });
    expect(sets[0].items.map((item) => item.contractorId)).toEqual([7, 8]);
    expect(sets[0].outcomes).toEqual([{ chosenContractorId: 7, chosenFeatures: null, chosenRank: 1, outcome: "chose_suggested" }]);
  });
});

describe("the command line", () => {
  it("reads every option", () => {
    expect(
      parseEvalArgs(["--target", "localhost,1433/floorplan_review", "--since", "2026-10-01", "--include-test", "--ranker", "rules@1", "--json", "--export", "rows.jsonl", "--replay", "./r.js", "--allow-remote"]),
    ).toEqual({
      allowRemote: true,
      export: "rows.jsonl",
      help: false,
      includeTest: true,
      json: true,
      ranker: "rules@1",
      replay: "./r.js",
      since: "2026-10-01",
      target: "localhost,1433/floorplan_review",
    });
  });

  it("has nothing on by default", () => {
    expect(parseEvalArgs([])).toEqual({ allowRemote: false, export: null, help: false, includeTest: false, json: false, ranker: null, replay: null, since: null, target: null });
  });

  it("rejects an unknown option, a missing value and a bad date", () => {
    expect(() => parseEvalArgs(["--apply"])).toThrow(/Unknown option --apply/);
    expect(() => parseEvalArgs(["--target"])).toThrow(/--target needs a value/);
    expect(() => parseEvalArgs(["--since", "--json"])).toThrow(/--since needs a value/);
    expect(() => parseEvalArgs(["--since", "yesterday"])).toThrow(/YYYY-MM-DD/);
  });
});

describe("the target", () => {
  it("defaults to the local review database", () => {
    expect(resolveEvalTarget({ allowRemote: false, target: null })).toEqual({ database: "floorplan_review", isLocal: true, server: "localhost" });
    expect(DEFAULT_EVAL_TARGET).toBe("localhost/floorplan_review");
  });

  it.each(["localhost", "LOCALHOST", "localhost,1433", "localhost:1433", "127.0.0.1", "127.0.0.1:1433", "tcp:localhost,1433", "[::1]", "[::1]:1433", "::1"])("treats %s as local", (server) => {
    expect(isLocalServer(server)).toBe(true);
    expect(resolveEvalTarget({ allowRemote: false, target: `${server}/db` }).isLocal).toBe(true);
  });

  it.each(["floorplan.database.windows.net", "localhost.example.com", "127.0.0.1.nip.io", "10.0.0.5", "0.0.0.0", "::ffff:127.0.0.1", "myserver"])("refuses %s without --allow-remote", (server) => {
    expect(isLocalServer(server)).toBe(false);
    expect(() => resolveEvalTarget({ allowRemote: false, target: `${server}/db` })).toThrow(/not localhost.*--allow-remote/);
  });

  it("reads a remote server only when told to", () => {
    expect(resolveEvalTarget({ allowRemote: true, target: "floorplan.database.windows.net/free-sql-db" })).toEqual({
      database: "free-sql-db",
      isLocal: false,
      server: "floorplan.database.windows.net",
    });
  });

  it("rejects a target that is not server/database", () => {
    expect(() => resolveEvalTarget({ allowRemote: true, target: "justaserver" })).toThrow(/<server>\/<database>/);
    expect(() => resolveEvalTarget({ allowRemote: true, target: "/db" })).toThrow(/<server>\/<database>/);
  });
});
