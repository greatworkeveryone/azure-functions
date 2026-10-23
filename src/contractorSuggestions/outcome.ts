// Contractor suggestions (SC-AI3): record what the person chose against the set
// they were shown. A choice that was one of the suggestions keeps the rank it
// held (its features are already on the set); a choice that was not gets its
// features captured now, by the same code, so it can serve as a training example
// as well. No HTTP in here: src/functions/recordContractorSuggestionOutcome.ts
// is the thin handler.

import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../db";
import { loadFeatureVectors } from "./candidates";
import { logOutcomes, readSet, type LoggedOutcome, type LogActor, type OutcomeKind } from "./eventLog";
import { FEATURE_SCHEMA_VERSION } from "./features";
import { loadBuilding } from "./load";
import type { FeatureVector } from "./types";

export interface OutcomeInput {
  chosenContractorIds: readonly number[];
  dismissed: boolean;
  jobId: number | null;
  suggestionSetId: number;
}

export interface RecordedChoice {
  chosenRank: number | null;
  contractorId: number | null;
  outcome: OutcomeKind;
}

export type OutcomeResult =
  | { ok: true; value: { featureCaptureFailed: boolean; outcomes: RecordedChoice[]; recorded: number } }
  | { error: string; ok: false; status: 400 | 404 };

const EXISTING_SQL = `SELECT ContractorID FROM dbo.Contractors WHERE ContractorID IN (SELECT CAST([value] AS INT) FROM OPENJSON(@Ids))`;

export async function recordOutcome(
  connection: Connection,
  input: OutcomeInput,
  actor: LogActor,
  options: { now?: Date } = {},
): Promise<OutcomeResult> {
  const set = await readSet(connection, input.suggestionSetId);
  // One answer for "no such set", "someone else's set" and "another job's set": nothing says which.
  if (!set || set.actorOid !== actor.oid || set.jobId !== input.jobId) {
    return { error: "Suggestion set not found for this job", ok: false, status: 404 };
  }

  if (input.dismissed) {
    const outcomes: LoggedOutcome[] = [{ chosenContractorId: null, chosenFeatures: null, chosenRank: null, outcome: "dismissed" }];
    const recorded = await logOutcomes(connection, actor, set.setId, outcomes);
    return { ok: true, value: { featureCaptureFailed: false, outcomes: [{ chosenRank: null, contractorId: null, outcome: "dismissed" }], recorded } };
  }

  const known = await executeQuery(connection, EXISTING_SQL, [{ name: "Ids", type: TYPES.NVarChar, value: JSON.stringify(input.chosenContractorIds) }]);
  const exists = new Set(known.map((row) => Number(row.ContractorID)));
  if (input.chosenContractorIds.some((id) => !exists.has(id))) return { error: "Unknown contractor", ok: false, status: 400 };

  // Features for the choices that were not suggested; the same schema as the set, or none at all.
  const others = input.chosenContractorIds.filter((id) => !set.ranks.has(id));
  let captured = new Map<number, FeatureVector>();
  let featureCaptureFailed = false;
  if (others.length > 0 && set.featureSchemaVersion === FEATURE_SCHEMA_VERSION) {
    try {
      const building = await loadBuilding(connection, set.buildingId);
      captured = await loadFeatureVectors(
        connection,
        { buildingId: set.buildingId, buildingRegion: building?.region ?? null, showTest: set.isTest, trade: set.trade },
        { activeOnly: false, ids: others },
        others,
        options.now,
      );
    } catch {
      featureCaptureFailed = true;
    }
  } else if (others.length > 0) {
    featureCaptureFailed = true;
  }

  const outcomes: LoggedOutcome[] = input.chosenContractorIds.map((contractorId) => {
    const rank = set.ranks.get(contractorId) ?? null;
    return {
      chosenContractorId: contractorId,
      chosenFeatures: rank === null ? (captured.get(contractorId) ?? null) : null,
      chosenRank: rank,
      outcome: rank === null ? "chose_other" : "chose_suggested",
    };
  });
  const recorded = await logOutcomes(connection, actor, set.setId, outcomes);
  return {
    ok: true,
    value: {
      featureCaptureFailed,
      outcomes: outcomes.map((outcome) => ({ chosenRank: outcome.chosenRank, contractorId: outcome.chosenContractorId, outcome: outcome.outcome })),
      recorded,
    },
  };
}
