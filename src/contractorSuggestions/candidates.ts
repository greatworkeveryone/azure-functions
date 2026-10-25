// Contractor suggestions (SC-AI3): load what is recorded and turn it into one
// feature vector per contractor. Used both to suggest (every contractor who may
// be suggested) and to capture the features of someone chosen who was not
// suggested, so the two can never drift apart.

import type { Connection } from "tedious";
import { todayInDarwin } from "../darwinDate";
import { assignedContractorIds, buildFeatureVector, knownServiceRegion, twelveMonthsAgo } from "./features";
import {
  loadAssignmentPlan,
  loadCertificates,
  loadEngagements,
  loadProfiles,
  loadQuoteStatuses,
  type Who,
} from "./load";
import type { FeatureVector, SuggestionContext } from "./types";

/** The part of a request that decides the features: where, for what trade, and whether test records count. */
export interface FeatureScope {
  buildingId: number;
  buildingRegion: string | null;
  showTest: boolean;
  trade: string | null;
}

export function suggestionContext(
  scope: FeatureScope,
  extra: { context: SuggestionContext["context"]; jobId: number | null },
  now: Date = new Date(),
): SuggestionContext {
  return {
    buildingId: scope.buildingId,
    buildingRegion: knownServiceRegion(scope.buildingRegion),
    context: extra.context,
    jobId: extra.jobId,
    today: todayInDarwin(now),
    trade: scope.trade,
  };
}

/** Feature vectors for `who`, keyed by contractor id; a contractor nothing is recorded about still gets one (all unknown or zero). */
export async function loadFeatureVectors(
  connection: Connection,
  scope: FeatureScope,
  who: Who,
  ids: readonly number[],
  now: Date = new Date(),
): Promise<Map<number, FeatureVector>> {
  const today = todayInDarwin(now);
  const since = twelveMonthsAgo(today);
  const region = knownServiceRegion(scope.buildingRegion);

  // One after another: a tedious connection serves one request at a time.
  const plan = await loadAssignmentPlan(connection, scope.buildingId);
  const profiles = await loadProfiles(connection);
  const certificates = await loadCertificates(connection, who);
  const engagements = await loadEngagements(connection, { buildingId: scope.buildingId, showTest: scope.showTest, since, who });
  const quotes = await loadQuoteStatuses(connection, { showTest: scope.showTest, since, who });
  const assigned = assignedContractorIds(plan, scope.trade);

  return new Map(
    ids.map((contractorId) => [
      contractorId,
      buildFeatureVector({
        assignedToBuilding: assigned.has(contractorId),
        buildingId: scope.buildingId,
        buildingRegion: region,
        certificates: certificates.get(contractorId) ?? [],
        engagements: engagements.get(contractorId) ?? [],
        profile: profiles.get(contractorId) ?? null,
        quoteStatuses: quotes.get(contractorId) ?? [],
        since,
        today,
        trade: scope.trade,
      }),
    ]),
  );
}
