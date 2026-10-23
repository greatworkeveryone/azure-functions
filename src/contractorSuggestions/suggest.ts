// Contractor suggestions (SC-AI3): ask for suggestions. Resolves what is being
// chosen for (a job, or a building and trade), computes the features of every
// contractor who may be suggested, lets the active ranker order them, and logs
// the top five with the exact features and the reasons shown. No HTTP in here:
// src/functions/suggestContractors.ts is the thin handler.

import type { Connection } from "tedious";
import { suggestionContext, loadFeatureVectors, type FeatureScope } from "./candidates";
import { logSuggestionSet, type LogActor } from "./eventLog";
import { canonicalTrade, FEATURE_SCHEMA_VERSION } from "./features";
import { loadBuilding, loadJob, loadPool, loadRequestedContractorIds, WHO_POOL } from "./load";
import type { Candidate, Ranker, Reason, SuggestionContextKind, SuggestionItem } from "./types";

/** How many suggestions are returned and logged. The screens show the first three. */
export const MAX_SUGGESTIONS = 5;

export type SuggestInput =
  | { context: SuggestionContextKind; jobId: number }
  | { buildingId: number; context: SuggestionContextKind; trade: string };

export interface SuggestResult {
  buildingId: number;
  candidates: SuggestionItem[];
  context: SuggestionContextKind;
  featureSchemaVersion: string;
  jobId: number | null;
  rankerVersion: string;
  suggestionSetId: number;
  trade: string | null;
}

export type SuggestOutcome =
  | { ok: true; value: SuggestResult }
  | { error: string; ok: false; status: 404 };

const MAX_REASONS = 8;
const MAX_REASON_LENGTH = 200;

/** At most a few lines of plain text, each one a sentence's length: nothing a ranker returns can swamp a screen or a log row. */
export function tidyReasons(reasons: readonly Reason[] | undefined): Reason[] {
  return (Array.isArray(reasons) ? reasons : [])
    .filter((reason) => typeof reason?.text === "string" && reason.text.trim() !== "")
    .slice(0, MAX_REASONS)
    .map((reason) => ({ caution: reason.caution === true, text: reason.text.trim().slice(0, MAX_REASON_LENGTH) }));
}

export async function suggest(
  connection: Connection,
  input: SuggestInput,
  actor: LogActor,
  options: { now?: Date; ranker: Ranker; showTest: boolean },
): Promise<SuggestOutcome> {
  let buildingId: number;
  let trade: string | null;
  let jobId: number | null = null;
  let isTest = options.showTest;

  if ("jobId" in input) {
    const job = await loadJob(connection, input.jobId);
    if (!job) return { error: "Job not found", ok: false, status: 404 };
    buildingId = job.buildingId;
    trade = canonicalTrade(job.category);
    jobId = job.jobId;
    isTest = isTest || job.isTest;
  } else {
    buildingId = input.buildingId;
    trade = canonicalTrade(input.trade);
  }

  const building = await loadBuilding(connection, buildingId);
  if (!building && jobId === null) return { error: "Building not found", ok: false, status: 404 };

  const scope: FeatureScope = { buildingId, buildingRegion: building?.region ?? null, showTest: isTest, trade };
  const context = suggestionContext(scope, { context: input.context, jobId }, options.now);

  // Someone already asked to quote on this job cannot be added again, so they are not suggested again.
  const pool = await loadPool(connection);
  const asked = input.context === "quote_request" && jobId !== null ? await loadRequestedContractorIds(connection, jobId) : new Set<number>();
  const eligible = pool.filter((contractor) => !asked.has(contractor.contractorId));

  const vectors = await loadFeatureVectors(connection, scope, WHO_POOL, eligible.map((contractor) => contractor.contractorId), options.now);
  const candidates: Candidate[] = eligible.map((contractor) => ({
    contractorId: contractor.contractorId,
    features: vectors.get(contractor.contractorId) as Candidate["features"],
    name: contractor.name,
  }));

  // Whatever a ranker returns is untrusted: only contractors it was given can be suggested (a learned
  // or LLM ranker that names someone else, a retired id or an invented one, cannot put them on screen),
  // each once, with a real score, and with reasons short enough to show and to log.
  const allowed = new Set(candidates.map((candidate) => candidate.contractorId));
  const seen = new Set<number>();
  const scored = (await options.ranker.rank(candidates, context))
    .filter((item) => {
      if (!allowed.has(item.contractorId) || seen.has(item.contractorId) || !Number.isFinite(item.score)) return false;
      seen.add(item.contractorId);
      return true;
    })
    .map((item) => ({ ...item, reasons: tidyReasons(item.reasons) }));
  const top = scored.slice(0, MAX_SUGGESTIONS);

  const suggestionSetId = await logSuggestionSet(
    connection,
    actor,
    {
      buildingId,
      candidateCount: scored.length,
      context: input.context,
      featureSchemaVersion: FEATURE_SCHEMA_VERSION,
      isTest,
      jobId,
      rankerVersion: options.ranker.version,
      trade,
    },
    top.map((item, index) => ({ contractorId: item.contractorId, features: item.features, rank: index + 1, reasons: item.reasons, score: item.score })),
  );

  return {
    ok: true,
    value: {
      buildingId,
      candidates: top.map((item, index) => ({
        certificate: { daysToExpiry: item.features.certificateDaysToExpiry, status: item.features.certificateStatus },
        contractorId: item.contractorId,
        name: item.name,
        rank: index + 1,
        reasons: item.reasons,
        score: item.score,
      })),
      context: input.context,
      featureSchemaVersion: FEATURE_SCHEMA_VERSION,
      jobId,
      rankerVersion: options.ranker.version,
      suggestionSetId,
      trade,
    },
  };
}
