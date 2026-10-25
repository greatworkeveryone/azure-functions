// Contractor suggestions (SC-AI3): the append-only record (migration 171). This
// file only ever INSERTs and SELECTs on the three tables; a guard test
// (contractor-suggestion-append-only.test.ts) fails if any code anywhere updates
// or deletes them, and the tables refuse it themselves through triggers.

import { TYPES, type Connection } from "tedious";
import { inTransaction, txOk } from "../assetRegisterSupport";
import { executeQuery, type SqlParam } from "../db";
import type { FeatureVector, Reason, SuggestionContextKind } from "./types";

export interface LogActor {
  name: string;
  oid: string;
}

export interface LoggedItem {
  contractorId: number;
  features: FeatureVector;
  rank: number;
  reasons: Reason[];
  score: number;
}

export interface LoggedSet {
  buildingId: number;
  candidateCount: number;
  context: SuggestionContextKind;
  featureSchemaVersion: string;
  isTest: boolean;
  jobId: number | null;
  rankerVersion: string;
  trade: string | null;
}

export interface StoredSet {
  actorOid: string;
  buildingId: number;
  context: SuggestionContextKind;
  featureSchemaVersion: string;
  isTest: boolean;
  jobId: number | null;
  ranks: Map<number, number>;
  setId: number;
  trade: string | null;
}

export type OutcomeKind = "chose_suggested" | "chose_other" | "dismissed";

export interface LoggedOutcome {
  chosenContractorId: number | null;
  chosenFeatures: FeatureVector | null;
  chosenRank: number | null;
  outcome: OutcomeKind;
}

const INSERT_SET = `INSERT INTO dbo.ContractorSuggestionSets
    (ActorName, ActorOid, JobId, BuildingId, Trade, Context, RankerVersion, FeatureSchemaVersion, CandidateCount, IsTest)
  OUTPUT INSERTED.SetId
  VALUES (@ActorName, @ActorOid, @JobId, @BuildingId, @Trade, @Context, @RankerVersion, @FeatureSchemaVersion, @CandidateCount, @IsTest)`;

const INSERT_ITEM = `INSERT INTO dbo.ContractorSuggestionItems (SetId, ContractorId, [Rank], Score, FeaturesJson, ReasonsJson)
  VALUES (@SetId, @ContractorId, @Rank, @Score, @FeaturesJson, @ReasonsJson)`;

// Recording the same choice twice (a retried request) adds nothing the second time.
const INSERT_OUTCOME = `INSERT INTO dbo.ContractorSuggestionOutcomes
    (SetId, ChosenContractorId, ChosenRank, Outcome, ChosenFeaturesJson, ActorName, ActorOid)
  SELECT @SetId, @ChosenContractorId, @ChosenRank, @Outcome, @ChosenFeaturesJson, @ActorName, @ActorOid
  WHERE NOT EXISTS (
    SELECT 1 FROM dbo.ContractorSuggestionOutcomes
     WHERE SetId = @SetId AND (ChosenContractorId = @ChosenContractorId OR (ChosenContractorId IS NULL AND @ChosenContractorId IS NULL))
  )`;

const SELECT_SET = `SELECT SetId, ActorOid, JobId, BuildingId, Trade, Context, FeatureSchemaVersion, IsTest
  FROM dbo.ContractorSuggestionSets WHERE SetId = @SetId`;

const SELECT_ITEMS = `SELECT ContractorId, [Rank] FROM dbo.ContractorSuggestionItems WHERE SetId = @SetId`;

/** A duplicate-key error from a concurrent identical request: the choice is already on record. */
function isDuplicateKey(error: unknown): boolean {
  const number = (error as { number?: number } | null)?.number;
  return number === 2601 || number === 2627;
}

/** Writes the set and its items in one transaction and returns the set's id. */
export async function logSuggestionSet(connection: Connection, actor: LogActor, set: LoggedSet, items: readonly LoggedItem[]): Promise<number> {
  const result = await inTransaction(connection, async () => {
    const [row] = await executeQuery(connection, INSERT_SET, [
      { name: "ActorName", type: TYPES.NVarChar, value: actor.name },
      { name: "ActorOid", type: TYPES.NVarChar, value: actor.oid },
      { name: "JobId", type: TYPES.Int, value: set.jobId },
      { name: "BuildingId", type: TYPES.Int, value: set.buildingId },
      { name: "Trade", type: TYPES.NVarChar, value: set.trade },
      { name: "Context", type: TYPES.VarChar, value: set.context },
      { name: "RankerVersion", type: TYPES.NVarChar, value: set.rankerVersion },
      { name: "FeatureSchemaVersion", type: TYPES.NVarChar, value: set.featureSchemaVersion },
      { name: "CandidateCount", type: TYPES.Int, value: set.candidateCount },
      { name: "IsTest", type: TYPES.Bit, value: set.isTest },
    ]);
    const setId = Number(row.SetId);
    for (const item of items) {
      await executeQuery(connection, INSERT_ITEM, [
        { name: "SetId", type: TYPES.Int, value: setId },
        { name: "ContractorId", type: TYPES.Int, value: item.contractorId },
        { name: "Rank", type: TYPES.Int, value: item.rank },
        { name: "Score", type: TYPES.Float, value: item.score },
        { name: "FeaturesJson", type: TYPES.NVarChar, value: JSON.stringify(item.features) },
        { name: "ReasonsJson", type: TYPES.NVarChar, value: JSON.stringify(item.reasons) },
      ]);
    }
    return txOk(setId);
  });
  if (!result.ok) throw new Error("Could not record the suggestion set");
  return result.value;
}

/** The set a person is answering and the rank each suggested contractor held; null when there is no such set. */
export async function readSet(connection: Connection, setId: number): Promise<StoredSet | null> {
  const param: SqlParam = { name: "SetId", type: TYPES.Int, value: setId };
  const [row] = await executeQuery(connection, SELECT_SET, [param]);
  if (!row) return null;
  const items = await executeQuery(connection, SELECT_ITEMS, [param]);
  return {
    actorOid: String(row.ActorOid),
    buildingId: Number(row.BuildingId),
    context: row.Context as SuggestionContextKind,
    featureSchemaVersion: String(row.FeatureSchemaVersion),
    isTest: row.IsTest === true || row.IsTest === 1,
    jobId: row.JobId === null || row.JobId === undefined ? null : Number(row.JobId),
    ranks: new Map(items.map((item) => [Number(item.ContractorId), Number(item.Rank)])),
    setId: Number(row.SetId),
    trade: (row.Trade as string | null) ?? null,
  };
}

/** Appends the outcomes; returns how many were new (a repeat of one already on record adds nothing). */
export async function logOutcomes(connection: Connection, actor: LogActor, setId: number, outcomes: readonly LoggedOutcome[]): Promise<number> {
  const result = await inTransaction(connection, async () => {
    let added = 0;
    for (const outcome of outcomes) {
      try {
        const rows = await executeQuery(connection, `${INSERT_OUTCOME};\nSELECT @@ROWCOUNT AS Added`, [
          { name: "SetId", type: TYPES.Int, value: setId },
          { name: "ChosenContractorId", type: TYPES.Int, value: outcome.chosenContractorId },
          { name: "ChosenRank", type: TYPES.Int, value: outcome.chosenRank },
          { name: "Outcome", type: TYPES.VarChar, value: outcome.outcome },
          { name: "ChosenFeaturesJson", type: TYPES.NVarChar, value: outcome.chosenFeatures ? JSON.stringify(outcome.chosenFeatures) : null },
          { name: "ActorName", type: TYPES.NVarChar, value: actor.name },
          { name: "ActorOid", type: TYPES.NVarChar, value: actor.oid },
        ]);
        added += Number(rows[0]?.Added ?? 0);
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }
    }
    return txOk(added);
  });
  if (!result.ok) throw new Error("Could not record the outcome");
  return result.value;
}
