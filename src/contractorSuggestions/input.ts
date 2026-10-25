// Contractor suggestions (SC-AI3): what the two routes accept. Every field is
// checked before the database is touched; the person is never taken from the
// body (the caller's name and id come from the verified token).

import { ASSET_CATEGORIES } from "../assetRegister";
import { canonicalTrade } from "./features";
import type { OutcomeInput } from "./outcome";
import type { SuggestInput } from "./suggest";
import { SUGGESTION_CONTEXTS, type SuggestionContextKind } from "./types";

export type Parsed<T> = { error: string; ok: false } | { ok: true; value: T };

const MAX_INT = 2_147_483_647;
const MAX_CHOSEN = 10;

const fail = (error: string): { error: string; ok: false } => ({ error, ok: false });
const isId = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_INT;

function readContext(value: unknown): SuggestionContextKind | null {
  return (SUGGESTION_CONTEXTS as readonly unknown[]).includes(value) ? (value as SuggestionContextKind) : null;
}

export function parseSuggestInput(body: Record<string, unknown>): Parsed<SuggestInput> {
  const context = readContext(body.context);
  if (!context) return fail(`context must be one of: ${SUGGESTION_CONTEXTS.join(", ")}`);

  const hasJob = body.jobId !== undefined && body.jobId !== null;
  const hasBuilding = body.buildingId !== undefined && body.buildingId !== null;
  if (hasJob && hasBuilding) return fail("Send a job, or a building and a trade, not both");
  if (hasJob) {
    if (!isId(body.jobId)) return fail("jobId must be a whole number above zero");
    return { ok: true, value: { context, jobId: body.jobId } };
  }
  if (!hasBuilding) return fail("Send a jobId, or a buildingId and a trade");

  // Manual buildings have negative ids; zero is never a building.
  const buildingId = body.buildingId;
  if (typeof buildingId !== "number" || !Number.isInteger(buildingId) || buildingId === 0 || Math.abs(buildingId) > MAX_INT) {
    return fail("buildingId must be a building id");
  }
  const trade = typeof body.trade === "string" ? canonicalTrade(body.trade) : null;
  if (!trade) return fail(`trade must be one of: ${ASSET_CATEGORIES.join(", ")}`);
  return { ok: true, value: { buildingId, context, trade } };
}

export function parseOutcomeInput(body: Record<string, unknown>): Parsed<OutcomeInput> {
  if (!isId(body.suggestionSetId)) return fail("suggestionSetId must be a whole number above zero");
  const jobId = body.jobId === undefined || body.jobId === null ? null : body.jobId;
  if (jobId !== null && !isId(jobId)) return fail("jobId must be a whole number above zero");
  if (body.dismissed !== undefined && typeof body.dismissed !== "boolean") return fail("dismissed must be true or false");
  const dismissed = body.dismissed === true;

  const raw = body.chosenContractorIds ?? [];
  if (!Array.isArray(raw) || raw.length > MAX_CHOSEN || !raw.every(isId)) {
    return fail(`chosenContractorIds must be a list of up to ${MAX_CHOSEN} contractor ids`);
  }
  const chosen = [...new Set(raw as number[])];
  if (dismissed && chosen.length > 0) return fail("A dismissed set has no chosen contractor");
  if (!dismissed && chosen.length === 0) return fail("Say who was chosen, or that the suggestions were dismissed");
  return { ok: true, value: { chosenContractorIds: chosen, dismissed, jobId, suggestionSetId: body.suggestionSetId } };
}
