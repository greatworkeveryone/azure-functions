// Inbound email triage (EB3): the append-only record (migration 176). This file only ever INSERTs
// and SELECTs on the three tables; a guard test (inbound-triage-append-only.test.ts) fails if any
// code anywhere updates or deletes them, and the tables refuse it themselves through triggers.
//
// The write helpers take a connection that is already inside the caller's transaction, so a set,
// the assignment it led to, its outcome and the ledger row commit or roll back together.

import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../db";
import type { Decision, FeatureVector, Intent, Lane, OutcomeKind, Reason, TriageContext, Urgency, WorkSource } from "./types";

export interface LoggedSet {
  actorName: string;
  candidateCount: number;
  category: string | null;
  context: TriageContext;
  decision: Decision;
  featureSchemaVersion: string;
  intent: Intent;
  isTest: boolean;
  lane: Lane;
  rankerVersion: string;
  urgency: Urgency | null;
  workSource: WorkSource;
}

export interface LoggedItem {
  features: FeatureVector;
  rank: number;
  reasons: Reason[];
  score: number;
  userId: number;
}

export interface LoggedOutcome {
  actorName: string;
  actorOid: string | null;
  chosenFeatures: FeatureVector | null;
  chosenRank: number | null;
  chosenUserId: number;
  emailId: number;
  outcome: OutcomeKind;
  previousUserId: number | null;
  setId: number;
}

export interface StoredSet {
  context: TriageContext | null;
  decision: Decision;
  featureSchemaVersion: string;
  isTest: boolean;
  items: StoredItem[];
  setId: number;
}

export interface StoredItem {
  features: FeatureVector;
  rank: number;
  reasons: Reason[];
  score: number;
  userId: number;
}

const INSERT_SET = `INSERT INTO dbo.EmailRoutingSets
    (EmailId, Mailbox, Decision, RankerVersion, FeatureSchemaVersion, Intent, Category, Lane, Urgency, WorkSource,
     LinkedSendId, ContextJson, CandidateCount, ActorName, IsTest)
  OUTPUT INSERTED.SetId
  VALUES (@EmailId, @Mailbox, @Decision, @RankerVersion, @FeatureSchemaVersion, @Intent, @Category, @Lane, @Urgency, @WorkSource,
     @LinkedSendId, @ContextJson, @CandidateCount, @ActorName, @IsTest)`;

const INSERT_ITEM = `INSERT INTO dbo.EmailRoutingItems (SetId, CandidateUserId, [Rank], Score, FeaturesJson, ReasonsJson)
  VALUES (@SetId, @UserId, @Rank, @Score, @FeaturesJson, @ReasonsJson)`;

const INSERT_OUTCOME = `INSERT INTO dbo.EmailRoutingOutcomes
    (SetId, EmailId, Outcome, ChosenUserId, ChosenRank, PreviousUserId, ChosenFeaturesJson, ActorName, ActorOid)
  VALUES (@SetId, @EmailId, @Outcome, @ChosenUserId, @ChosenRank, @PreviousUserId, @ChosenFeaturesJson, @ActorName, @ActorOid)`;

const SELECT_LATEST_SET = `SELECT TOP (1) SetId, Decision, FeatureSchemaVersion, ContextJson, IsTest
  FROM dbo.EmailRoutingSets WHERE EmailId = @EmailId ORDER BY SetId DESC`;

const SELECT_ITEMS = `SELECT CandidateUserId, [Rank], Score, FeaturesJson, ReasonsJson
  FROM dbo.EmailRoutingItems WHERE SetId = @SetId ORDER BY [Rank]`;

/** The set and its items, in the caller's open transaction. Returns the set's id. */
export async function insertSet(connection: Connection, set: LoggedSet, items: readonly LoggedItem[]): Promise<number> {
  const [row] = await executeQuery(connection, INSERT_SET, [
    { name: "EmailId", type: TYPES.Int, value: set.context.emailId },
    { name: "Mailbox", type: TYPES.NVarChar, value: set.context.mailbox },
    { name: "Decision", type: TYPES.VarChar, value: set.decision },
    { name: "RankerVersion", type: TYPES.NVarChar, value: set.rankerVersion },
    { name: "FeatureSchemaVersion", type: TYPES.NVarChar, value: set.featureSchemaVersion },
    { name: "Intent", type: TYPES.VarChar, value: set.intent },
    { name: "Category", type: TYPES.NVarChar, value: set.category },
    { name: "Lane", type: TYPES.VarChar, value: set.lane },
    { name: "Urgency", type: TYPES.VarChar, value: set.urgency },
    { name: "WorkSource", type: TYPES.VarChar, value: set.workSource },
    { name: "LinkedSendId", type: TYPES.NVarChar, value: set.context.linkedSend?.sendId ?? null },
    { name: "ContextJson", type: TYPES.NVarChar, value: JSON.stringify(set.context) },
    { name: "CandidateCount", type: TYPES.Int, value: set.candidateCount },
    { name: "ActorName", type: TYPES.NVarChar, value: set.actorName },
    { name: "IsTest", type: TYPES.Bit, value: set.isTest },
  ]);
  const setId = Number(row.SetId);
  for (const item of items) {
    await executeQuery(connection, INSERT_ITEM, [
      { name: "SetId", type: TYPES.Int, value: setId },
      { name: "UserId", type: TYPES.Int, value: item.userId },
      { name: "Rank", type: TYPES.Int, value: item.rank },
      { name: "Score", type: TYPES.Float, value: item.score },
      { name: "FeaturesJson", type: TYPES.NVarChar, value: JSON.stringify(item.features) },
      { name: "ReasonsJson", type: TYPES.NVarChar, value: JSON.stringify(item.reasons) },
    ]);
  }
  return setId;
}

/** One outcome, in the caller's open transaction. */
export async function insertOutcome(connection: Connection, outcome: LoggedOutcome): Promise<void> {
  await executeQuery(connection, INSERT_OUTCOME, [
    { name: "SetId", type: TYPES.Int, value: outcome.setId },
    { name: "EmailId", type: TYPES.Int, value: outcome.emailId },
    { name: "Outcome", type: TYPES.VarChar, value: outcome.outcome },
    { name: "ChosenUserId", type: TYPES.Int, value: outcome.chosenUserId },
    { name: "ChosenRank", type: TYPES.Int, value: outcome.chosenRank },
    { name: "PreviousUserId", type: TYPES.Int, value: outcome.previousUserId },
    { name: "ChosenFeaturesJson", type: TYPES.NVarChar, value: outcome.chosenFeatures ? JSON.stringify(outcome.chosenFeatures) : null },
    { name: "ActorName", type: TYPES.NVarChar, value: outcome.actorName },
    { name: "ActorOid", type: TYPES.NVarChar, value: outcome.actorOid },
  ]);
}

function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== "string") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** The newest set for an email, with its items by rank; null when triage never saw it. */
export async function readLatestSet(connection: Connection, emailId: number): Promise<StoredSet | null> {
  const [row] = await executeQuery(connection, SELECT_LATEST_SET, [{ name: "EmailId", type: TYPES.Int, value: emailId }]);
  if (!row) return null;
  const items = await executeQuery(connection, SELECT_ITEMS, [{ name: "SetId", type: TYPES.Int, value: Number(row.SetId) }]);
  return {
    context: parseJson<TriageContext | null>(row.ContextJson, null),
    decision: row.Decision as Decision,
    featureSchemaVersion: String(row.FeatureSchemaVersion),
    isTest: row.IsTest === true || row.IsTest === 1,
    items: items.map((item) => ({
      features: parseJson<FeatureVector>(item.FeaturesJson, {} as FeatureVector),
      rank: Number(item.Rank),
      reasons: parseJson<Reason[]>(item.ReasonsJson, []),
      score: Number(item.Score),
      userId: Number(item.CandidateUserId),
    })),
    setId: Number(row.SetId),
  };
}
