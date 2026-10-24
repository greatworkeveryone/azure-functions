import { createFakeDb, type Row } from "../__tests__/fixtures/contractorSuggestionsDb";
import { recordOutcome } from "./outcome";

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

const SET: Row = { ActorOid: "fay-oid", BuildingId: 10, Context: "quote_request", FeatureSchemaVersion: "cs-features@1", IsTest: false, JobId: 7, SetId: 55, Trade: "Electrical" };

function world(patch: { set?: Row | null; ranks?: [number, number][]; existing?: number[]; added?: number } = {}) {
  fake.reset();
  fake.answer(/FROM dbo\.ContractorSuggestionSets WHERE SetId/, patch.set === null ? [] : [patch.set ?? SET]);
  fake.answer(/FROM dbo\.ContractorSuggestionItems WHERE SetId/, (patch.ranks ?? [[1, 1], [2, 2], [3, 3]]).map(([ContractorId, Rank]) => ({ ContractorId, Rank })));
  fake.answer(/FROM dbo\.Contractors WHERE ContractorID IN/, (patch.existing ?? [1, 2, 3, 90, 91]).map((ContractorID) => ({ ContractorID })));
  fake.answer(/FROM dbo\.Buildings WHERE BuildingID/, [{ BuildingID: 10, Region: "Darwin" }]);
  fake.answer(/FROM dbo\.MaintenanceCoverage/, []);
  fake.answer(/FROM dbo\.ContractorCoverage/, [{ ContractorId: 90, CoverageJson: JSON.stringify({ regions: ["Darwin"], trades: ["Electrical"] }) }]);
  fake.answer(/FROM dbo\.RegisterDocuments/, []);
  fake.answer(/UNION/, [{ BuildingID: 10, Category: "Electrical", ContractorID: 90, CreatedAt: new Date("2026-09-01T00:00:00Z"), DoneAt: null, JobID: 50 }]);
  fake.answer(/SELECT q\.ContractorID, q\.Status/, []);
  fake.answer(/INSERT INTO dbo\.ContractorSuggestionOutcomes/, [{ Added: patch.added ?? 1 }]);
}

beforeEach(() => world());

const input = (patch: Partial<Parameters<typeof recordOutcome>[1]> = {}) => ({ chosenContractorIds: [1], dismissed: false, jobId: 7, suggestionSetId: 55, ...patch });
const inserts = () => fake.sentTo(/INSERT INTO dbo\.ContractorSuggestionOutcomes/);

describe("a set that is not the caller's to answer", () => {
  it.each([
    ["does not exist", { set: null }, {}],
    ["was shown to someone else", { set: { ...SET, ActorOid: "someone-else" } }, {}],
    ["belongs to another job", {}, { jobId: 8 }],
    ["belongs to a job when none is sent", {}, { jobId: null }],
    ["has no job when one is sent", { set: { ...SET, JobId: null } }, {}],
  ])("is a 404 when it %s, and nothing is recorded", async (_label, worldPatch, inputPatch) => {
    world(worldPatch as never);
    const result = await recordOutcome(connection, input(inputPatch), actor, { now: NOW });
    expect(result).toEqual({ error: "Suggestion set not found for this job", ok: false, status: 404 });
    expect(inserts()).toHaveLength(0);
  });

  it("accepts a set with no job when none is sent", async () => {
    world({ set: { ...SET, JobId: null } });
    const result = await recordOutcome(connection, input({ jobId: null }), actor, { now: NOW });
    expect(result.ok).toBe(true);
  });
});

describe("choosing one of the suggestions", () => {
  it("records it as suggested, with the rank it held and no new features", async () => {
    const result = await recordOutcome(connection, input({ chosenContractorIds: [2] }), actor, { now: NOW });
    expect(result).toEqual({ ok: true, value: { featureCaptureFailed: false, outcomes: [{ chosenRank: 2, contractorId: 2, outcome: "chose_suggested" }], recorded: 1 } });
    expect(inserts()[0].params).toEqual({
      ActorName: "Fay Facilities",
      ActorOid: "fay-oid",
      ChosenContractorId: 2,
      ChosenFeaturesJson: null,
      ChosenRank: 2,
      Outcome: "chose_suggested",
      SetId: 55,
    });
    expect(fake.sentTo(/RegisterDocuments|UNION/)).toHaveLength(0);
  });
});

describe("choosing someone who was not suggested", () => {
  it("records it as other, with their features worked out now by the same code", async () => {
    const result = await recordOutcome(connection, input({ chosenContractorIds: [90] }), actor, { now: NOW });
    expect(result.ok && result.value.outcomes).toEqual([{ chosenRank: null, contractorId: 90, outcome: "chose_other" }]);
    const [row] = inserts();
    expect(row.params).toMatchObject({ ChosenContractorId: 90, ChosenRank: null, Outcome: "chose_other" });
    expect(JSON.parse(row.params.ChosenFeaturesJson as string)).toMatchObject({ jobsHere12m: 1, regionMatch: true, tradeCovered: true });
  });

  it("reads only that contractor, whatever their status, and counts test records as the set did", async () => {
    world({ set: { ...SET, IsTest: true } });
    await recordOutcome(connection, input({ chosenContractorIds: [90] }), actor, { now: NOW });
    const reads = fake.sentTo(/RegisterDocuments|UNION|SELECT q\.ContractorID/);
    expect(reads).toHaveLength(3);
    for (const read of reads) {
      expect(read.params.Ids).toBe("[90]");
      expect(read.params.ActiveOnly).toBe(false);
    }
    expect(fake.sentTo(/UNION/)[0].params.ShowTest).toBe(true);
  });

  it("still records the choice, without features, when they cannot be worked out", async () => {
    fake.answer(/UNION/, () => {
      throw new Error("timeout");
    });
    const result = await recordOutcome(connection, input({ chosenContractorIds: [90] }), actor, { now: NOW });
    expect(result.ok && result.value.featureCaptureFailed).toBe(true);
    expect(inserts()[0].params).toMatchObject({ ChosenContractorId: 90, ChosenFeaturesJson: null, Outcome: "chose_other" });
  });

  it("captures no features for a set made under another feature schema, and says so", async () => {
    world({ set: { ...SET, FeatureSchemaVersion: "cs-features@0" } });
    const result = await recordOutcome(connection, input({ chosenContractorIds: [90] }), actor, { now: NOW });
    expect(result.ok && result.value.featureCaptureFailed).toBe(true);
    expect(inserts()[0].params.ChosenFeaturesJson).toBeNull();
    expect(fake.sentTo(/UNION/)).toHaveLength(0);
  });

  it("is a 400 for a contractor that does not exist, and records nothing", async () => {
    const result = await recordOutcome(connection, input({ chosenContractorIds: [1, 4040] }), actor, { now: NOW });
    expect(result).toEqual({ error: "Unknown contractor", ok: false, status: 400 });
    expect(inserts()).toHaveLength(0);
  });
});

describe("several chosen at once (a quote request to more than one contractor)", () => {
  it("records each against the set: suggested ones with their rank, the others without", async () => {
    const result = await recordOutcome(connection, input({ chosenContractorIds: [1, 90, 3] }), actor, { now: NOW });
    expect(result.ok && result.value.outcomes).toEqual([
      { chosenRank: 1, contractorId: 1, outcome: "chose_suggested" },
      { chosenRank: null, contractorId: 90, outcome: "chose_other" },
      { chosenRank: 3, contractorId: 3, outcome: "chose_suggested" },
    ]);
    expect(inserts()).toHaveLength(3);
  });
});

describe("dismissing", () => {
  it("records a dismissal with no contractor and reads nothing else", async () => {
    const result = await recordOutcome(connection, input({ chosenContractorIds: [], dismissed: true }), actor, { now: NOW });
    expect(result).toEqual({ ok: true, value: { featureCaptureFailed: false, outcomes: [{ chosenRank: null, contractorId: null, outcome: "dismissed" }], recorded: 1 } });
    expect(inserts()[0].params).toMatchObject({ ChosenContractorId: null, ChosenRank: null, Outcome: "dismissed" });
    expect(fake.sentTo(/FROM dbo\.Contractors/)).toHaveLength(0);
  });
});

describe("the same choice sent twice", () => {
  it("adds nothing the second time: the insert is guarded by what is already on record", async () => {
    world({ added: 0 });
    const result = await recordOutcome(connection, input(), actor, { now: NOW });
    expect(result.ok && result.value.recorded).toBe(0);
    expect(inserts()[0].sql).toMatch(/WHERE NOT EXISTS/);
  });

  it("treats a duplicate-key race with another identical request as already recorded", async () => {
    fake.answer(/INSERT INTO dbo\.ContractorSuggestionOutcomes/, () => {
      throw Object.assign(new Error("Cannot insert duplicate key"), { number: 2601 });
    });
    const result = await recordOutcome(connection, input(), actor, { now: NOW });
    expect(result.ok && result.value.recorded).toBe(0);
  });

  it("does not hide any other failure", async () => {
    fake.answer(/INSERT INTO dbo\.ContractorSuggestionOutcomes/, () => {
      throw Object.assign(new Error("deadlock"), { number: 1205 });
    });
    await expect(recordOutcome(connection, input(), actor, { now: NOW })).rejects.toThrow("deadlock");
  });
});
