import { createFakeDb, type Row } from "../__tests__/fixtures/contractorSuggestionsDb";
import { FEATURE_SCHEMA_VERSION } from "./features";
import { MAX_SUGGESTIONS, suggest, tidyReasons } from "./suggest";
import { rulesRanker } from "./rulesRanker";
import type { Candidate, Ranker, ScoredCandidate } from "./types";

const fake = createFakeDb();

jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  executeQuery: (...args: unknown[]) => (jest.requireMock("../db") as { __fake: { executeQuery: (...a: unknown[]) => unknown } }).__fake.executeQuery(...args),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
(jest.requireMock("../db") as { __fake: unknown }).__fake = fake;

const actor = { name: "Fay Facilities", oid: "fay-oid" };
const NOW = new Date("2026-10-23T03:00:00Z");
const connection = {} as never;

const pool = (...entries: [number, string][]): Row[] => entries.map(([ContractorID, ContractorName]) => ({ ContractorID, ContractorName }));

function world(patch: { job?: Row | null; pool?: Row[]; requested?: number[]; building?: Row | null; plan?: unknown; profiles?: Row[]; certificates?: Row[]; engagements?: Row[]; quotes?: Row[] } = {}) {
  fake.reset();
  const job = patch.job === undefined ? { BuildingID: 10, Category: "Electrical", IsInternal: false, IsTest: false, JobID: 7 } : patch.job;
  const building = patch.building === undefined ? { BuildingID: 10, Region: "Darwin" } : patch.building;
  fake.answer(/FROM dbo\.Jobs WHERE JobID/, job ? [job] : []);
  fake.answer(/FROM dbo\.Buildings WHERE BuildingID/, building ? [building] : []);
  fake.answer(/FROM dbo\.Contractors WHERE Active = 1 AND Suspended = 0/, patch.pool ?? pool([1, "Alpha Electrical"], [2, "Beta Electrical"], [3, "Nobody Known"]));
  fake.answer(/FROM dbo\.JobRequestedContractors/, (patch.requested ?? []).map((ContractorID) => ({ ContractorID })));
  fake.answer(/FROM dbo\.MaintenanceCoverage/, patch.plan === undefined ? [{ PlanJson: JSON.stringify([{ contractorIds: [2], required: false, trade: "Electrical" }]) }] : [{ PlanJson: JSON.stringify(patch.plan) }]);
  fake.answer(/FROM dbo\.ContractorCoverage/, patch.profiles ?? [{ ContractorId: 1, CoverageJson: JSON.stringify({ regions: ["Darwin"], trades: ["Electrical"] }) }]);
  fake.answer(/FROM dbo\.RegisterDocuments/, patch.certificates ?? [{ BuildingId: null, ContractorId: 1, ExpiresOn: new Date("2026-11-04T00:00:00Z"), InsuranceType: "Public liability", IssuedOn: null }]);
  fake.answer(/UNION/, patch.engagements ?? [{ BuildingID: 10, Category: "Electrical", ContractorID: 1, CreatedAt: new Date("2026-09-01T00:00:00Z"), DoneAt: null, JobID: 50 }]);
  fake.answer(/SELECT q\.ContractorID, q\.Status/, patch.quotes ?? []);
  fake.answer(/INSERT INTO dbo\.ContractorSuggestionSets/, [{ SetId: 55 }]);
  fake.answer(/INSERT INTO dbo\.ContractorSuggestionItems/, []);
}

beforeEach(() => world());

describe("suggest for a job", () => {
  it("returns candidates best first with their reasons and certificate state, and says which set it logged", async () => {
    const result = await suggest(connection, { context: "quote_request", jobId: 7 }, actor, { now: NOW, ranker: rulesRanker, showTest: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { value } = result;
    expect(value).toMatchObject({ buildingId: 10, context: "quote_request", featureSchemaVersion: FEATURE_SCHEMA_VERSION, jobId: 7, rankerVersion: "rules@1", suggestionSetId: 55, trade: "Electrical" });
    // Alpha covers Electrical in Darwin and has a recent job here (36 points, certificate expiring); Beta is assigned to the
    // building for Electrical but has no certificate on record (25); Nobody Known has no evidence at all.
    expect(value.candidates.map((candidate) => [candidate.rank, candidate.name])).toEqual([[1, "Alpha Electrical"], [2, "Beta Electrical"]]);
    const alpha = value.candidates[0];
    expect(alpha.reasons.map((reason) => reason.text)).toEqual(
      expect.arrayContaining(["Covers Electrical in Darwin", "1 job here in the last 12 months", "Certificate of currency expires in 12 days"]),
    );
    expect(alpha.certificate).toEqual({ daysToExpiry: 12, status: "expiring" });
    expect(value.candidates[1].certificate).toEqual({ daysToExpiry: null, status: "missing" });
    expect(value.candidates[1].reasons).toEqual(expect.arrayContaining([{ caution: true, text: "No certificate of currency recorded" }]));
  });

  it("never selects an inactive or suspended contractor: the pool and every feature read are limited to active, unsuspended ones", async () => {
    await suggest(connection, { context: "assign", jobId: 7 }, actor, { now: NOW, ranker: rulesRanker, showTest: false });
    expect(fake.sentTo(/FROM dbo\.Contractors WHERE/)[0].sql).toMatch(/Active = 1 AND Suspended = 0/);
    for (const read of fake.sentTo(/RegisterDocuments|UNION|SELECT q\.ContractorID/)) {
      expect(read.params.ActiveOnly).toBe(true);
      expect(read.params.Ids).toBeNull();
      expect(read.sql).toMatch(/c\.Active = 1 AND c\.Suspended = 0/);
    }
  });

  it("drops anyone a ranker names who was not a candidate, and anyone it names twice", async () => {
    const rogue: Ranker = {
      rank: (candidates: readonly Candidate[]): ScoredCandidate[] => [
        { ...candidates[0], reasons: [], score: 9 },
        { contractorId: 999, features: candidates[0].features, name: "Invented", reasons: [], score: 8 },
        { ...candidates[0], reasons: [], score: 7 },
      ],
      version: "rogue@1",
    };
    const result = await suggest(connection, { context: "assign", jobId: 7 }, actor, { now: NOW, ranker: rogue, showTest: false });
    expect(result.ok && result.value.candidates.map((candidate) => candidate.contractorId)).toEqual([1]);
    expect(result.ok && result.value.rankerVersion).toBe("rogue@1");
  });

  it("treats a ranker's output as untrusted: no unscored candidate, and reasons that are few, short and plain", async () => {
    const wordy: Ranker = {
      rank: (candidates: readonly Candidate[]): ScoredCandidate[] => [
        { ...candidates[0], reasons: Array.from({ length: 12 }, (_, index) => ({ caution: index === 0, text: `  Reason ${index} ${"x".repeat(400)}  ` })), score: 3 },
        { ...candidates[1], reasons: [{ caution: false, text: "Not a number" }], score: Number.NaN },
        { ...candidates[2], reasons: [{ caution: false, text: "Unbounded" }], score: Number.POSITIVE_INFINITY },
      ],
      version: "wordy@1",
    };
    const result = await suggest(connection, { context: "assign", jobId: 7 }, actor, { now: NOW, ranker: wordy, showTest: false });
    expect(result.ok && result.value.candidates.map((candidate) => candidate.contractorId)).toEqual([1]);
    const reasons = result.ok ? result.value.candidates[0].reasons : [];
    expect(reasons).toHaveLength(8);
    expect(reasons[0].caution).toBe(true);
    expect(reasons.every((reason) => reason.text.length <= 200 && reason.text === reason.text.trim())).toBe(true);
    const logged = JSON.parse(fake.sentTo(/INSERT INTO dbo\.ContractorSuggestionItems/)[0].params.ReasonsJson as string);
    expect(logged).toEqual(reasons);
  });

  it("leaves out contractors already asked to quote for a quote request, but not for an assignment", async () => {
    world({ requested: [2] });
    const quote = await suggest(connection, { context: "quote_request", jobId: 7 }, actor, { now: NOW, ranker: rulesRanker, showTest: false });
    expect(quote.ok && quote.value.candidates.map((candidate) => candidate.contractorId)).toEqual([1]);
    world({ requested: [2] });
    const assign = await suggest(connection, { context: "assign", jobId: 7 }, actor, { now: NOW, ranker: rulesRanker, showTest: false });
    expect(assign.ok && assign.value.candidates.map((candidate) => candidate.contractorId)).toEqual([1, 2]);
    expect(fake.sentTo(/JobRequestedContractors/)).toHaveLength(0);
  });

  it("returns at most five and records how many the ranker offered", async () => {
    const many = Array.from({ length: 8 }, (_, index) => [index + 1, `Contractor ${index + 1}`] as [number, string]);
    world({ pool: pool(...many), plan: [{ contractorIds: many.map(([id]) => id), required: false, trade: "Electrical" }] });
    const result = await suggest(connection, { context: "assign", jobId: 7 }, actor, { now: NOW, ranker: rulesRanker, showTest: false });
    expect(result.ok && result.value.candidates).toHaveLength(MAX_SUGGESTIONS);
    expect(fake.sentTo(/INSERT INTO dbo\.ContractorSuggestionSets/)[0].params.CandidateCount).toBe(8);
    expect(fake.sentTo(/INSERT INTO dbo\.ContractorSuggestionItems/)).toHaveLength(MAX_SUGGESTIONS);
  });

  it("logs the set and every item with the exact features, the reasons shown and the person who asked", async () => {
    await suggest(connection, { context: "quote_request", jobId: 7 }, actor, { now: NOW, ranker: rulesRanker, showTest: false });
    const [set] = fake.sentTo(/INSERT INTO dbo\.ContractorSuggestionSets/);
    expect(set.params).toEqual({
      ActorName: "Fay Facilities",
      ActorOid: "fay-oid",
      BuildingId: 10,
      CandidateCount: 2,
      Context: "quote_request",
      FeatureSchemaVersion: "cs-features@1",
      IsTest: false,
      JobId: 7,
      RankerVersion: "rules@1",
      Trade: "Electrical",
    });
    const items = fake.sentTo(/INSERT INTO dbo\.ContractorSuggestionItems/);
    expect(items.map((item) => [item.params.SetId, item.params.ContractorId, item.params.Rank])).toEqual([[55, 1, 1], [55, 2, 2]]);
    const alpha = JSON.parse(items[0].params.FeaturesJson as string);
    expect(alpha).toMatchObject({ assignedToBuilding: false, certificateStatus: "expiring", jobsHere12m: 1, jobsTrade12m: 1, regionMatch: true, tradeCovered: true });
    expect(Object.keys(alpha)).toHaveLength(12);
    expect(JSON.parse(items[0].params.ReasonsJson as string)[0]).toEqual({ caution: false, text: expect.any(String) });
    expect(items[0].params.Score).toBeCloseTo(rulesScore(alpha), 2);
    expect(items[0].params.Score).toBe(36);
  });

  it("writes the set and its items inside one transaction", async () => {
    const db = jest.requireMock("../db") as { beginTransaction: jest.Mock; commitTransaction: jest.Mock; rollbackTransaction: jest.Mock };
    db.beginTransaction.mockClear();
    db.commitTransaction.mockClear();
    await suggest(connection, { context: "assign", jobId: 7 }, actor, { now: NOW, ranker: rulesRanker, showTest: false });
    expect(db.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
  });

  it("rolls back and fails rather than return a set that was not logged", async () => {
    const db = jest.requireMock("../db") as { rollbackTransaction: jest.Mock };
    world();
    fake.answer(/INSERT INTO dbo\.ContractorSuggestionItems/, () => {
      throw new Error("disk full");
    });
    await expect(suggest(connection, { context: "assign", jobId: 7 }, actor, { now: NOW, ranker: rulesRanker, showTest: false })).rejects.toThrow("disk full");
    expect(db.rollbackTransaction).toHaveBeenCalled();
  });

  it("still logs a set when nobody qualifies, so coverage can be measured", async () => {
    world({ plan: [], profiles: [], engagements: [] });
    const result = await suggest(connection, { context: "quote_request", jobId: 7 }, actor, { now: NOW, ranker: rulesRanker, showTest: false });
    expect(result.ok && result.value.candidates).toEqual([]);
    expect(fake.sentTo(/INSERT INTO dbo\.ContractorSuggestionSets/)[0].params.CandidateCount).toBe(0);
    expect(fake.sentTo(/INSERT INTO dbo\.ContractorSuggestionItems/)).toHaveLength(0);
  });
});

describe("suggest for a job whose category is not a trade", () => {
  it("suggests on history alone and records no trade", async () => {
    world({ job: { BuildingID: 10, Category: "Common Areas", IsInternal: false, IsTest: false, JobID: 8 } });
    const result = await suggest(connection, { context: "assign", jobId: 8 }, actor, { now: NOW, ranker: rulesRanker, showTest: false });
    expect(result.ok && result.value.trade).toBeNull();
    expect(result.ok && result.value.candidates.map((candidate) => candidate.contractorId)).toEqual([1]);
    expect(fake.sentTo(/INSERT INTO dbo\.ContractorSuggestionSets/)[0].params.Trade).toBeNull();
  });
});

describe("suggest for a building and trade", () => {
  it("needs no job and logs none", async () => {
    const result = await suggest(connection, { buildingId: 10, context: "assign", trade: "Electrical" }, actor, { now: NOW, ranker: rulesRanker, showTest: false });
    expect(result.ok && result.value.jobId).toBeNull();
    expect(fake.sentTo(/FROM dbo\.Jobs WHERE JobID/)).toHaveLength(0);
    expect(fake.sentTo(/INSERT INTO dbo\.ContractorSuggestionSets/)[0].params.JobId).toBeNull();
  });
});

describe("not found", () => {
  it("is a 404 for a job that does not exist, before anything is logged", async () => {
    world({ job: null });
    const result = await suggest(connection, { context: "assign", jobId: 404 }, actor, { now: NOW, ranker: rulesRanker, showTest: false });
    expect(result).toEqual({ error: "Job not found", ok: false, status: 404 });
    expect(fake.sentTo(/INSERT/)).toHaveLength(0);
  });

  it("is a 404 for a building that does not exist", async () => {
    world({ building: null });
    const result = await suggest(connection, { buildingId: -99, context: "assign", trade: "Lifts" }, actor, { now: NOW, ranker: rulesRanker, showTest: false });
    expect(result).toEqual({ error: "Building not found", ok: false, status: 404 });
  });
});

describe("test records", () => {
  it("leaves them out of the history for a real job", async () => {
    await suggest(connection, { context: "assign", jobId: 7 }, actor, { now: NOW, ranker: rulesRanker, showTest: false });
    expect(fake.sentTo(/UNION/)[0].params.ShowTest).toBe(false);
    expect(fake.sentTo(/INSERT INTO dbo\.ContractorSuggestionSets/)[0].params.IsTest).toBe(false);
  });

  it("counts them for a test job, and marks the set as test so the evaluation can leave it out", async () => {
    world({ job: { BuildingID: 10, Category: "Electrical", IsInternal: false, IsTest: true, JobID: 7 } });
    await suggest(connection, { context: "assign", jobId: 7 }, actor, { now: NOW, ranker: rulesRanker, showTest: false });
    expect(fake.sentTo(/UNION/)[0].params.ShowTest).toBe(true);
    expect(fake.sentTo(/SELECT q\.ContractorID/)[0].params.ShowTest).toBe(true);
    expect(fake.sentTo(/INSERT INTO dbo\.ContractorSuggestionSets/)[0].params.IsTest).toBe(true);
  });

  it("counts them for an admin who turned Show test data on", async () => {
    await suggest(connection, { context: "assign", jobId: 7 }, actor, { now: NOW, ranker: rulesRanker, showTest: true });
    expect(fake.sentTo(/UNION/)[0].params.ShowTest).toBe(true);
    expect(fake.sentTo(/INSERT INTO dbo\.ContractorSuggestionSets/)[0].params.IsTest).toBe(true);
  });
});

/** Re-adds the rules points from a logged vector, to check the logged score is the one these features give. */
function rulesScore(features: Record<string, unknown>): number {
  const { componentsFor } = jest.requireActual("./rulesRanker") as typeof import("./rulesRanker");
  return componentsFor(features as never, { buildingId: 10, buildingRegion: "Darwin", context: "quote_request", jobId: 7, today: "2026-10-23", trade: "Electrical" }).reduce((sum, c) => sum + c.points, 0);
}

describe("tidyReasons", () => {
  it("keeps plain sentences in order, trimmed, and drops empty or non-text ones", () => {
    expect(tidyReasons([{ caution: false, text: " One " }, { caution: true, text: "" }, { caution: false, text: 7 as never }, { caution: true, text: "Two" }])).toEqual([
      { caution: false, text: "One" },
      { caution: true, text: "Two" },
    ]);
  });

  it("reads anything that is not true as not a caution, and a missing list as none", () => {
    expect(tidyReasons([{ caution: "yes" as never, text: "A" }])).toEqual([{ caution: false, text: "A" }]);
    expect(tidyReasons(undefined)).toEqual([]);
    expect(tidyReasons("nope" as never)).toEqual([]);
  });
});
