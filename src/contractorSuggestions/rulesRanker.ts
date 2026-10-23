// Contractor suggestions (SC-AI3): rules ranker v1, "rules@1". A sum of points,
// each point with the sentence a person reads beside the name, so nobody has to
// trust a number they cannot explain. It is the baseline a learned or LLM ranker
// has to beat (see ./evaluation), and it is useful before there is any history:
// what people recorded about coverage and building assignments carries it.
//
// Rules, in the order of the weights below:
// - Only recorded facts score. A gap in what was recorded scores nothing; it is
//   not held against anyone (production holds almost no coverage data yet).
// - A contractor with no positive evidence for this job is left out rather than
//   padded in: the list is "who is likely right", not "who is on file".
// - A missing, expired or expiring certificate of currency, or a recorded
//   mismatch of trade or region, lowers the score and is shown as a caution,
//   never hidden and never a reason to drop someone (warnings never block, 21 Oct).
// Features the rules do not weigh (days since the last job here) are still
// logged, for the learned ranker.

import type { Candidate, FeatureVector, Ranker, Reason, ScoredCandidate, SuggestionContext } from "./types";

/**
 * Why each weight is what it is. They are judgement, not fitted: the aim is the
 * right order of magnitude so the strongest explicit statement wins and history
 * only breaks ties between contractors who are equally on paper.
 */
export const RULES_V1_WEIGHTS = {
  // The building's own plan names this contractor for this trade: the strongest,
  // most deliberate statement a manager has made about who should do the work.
  assignedToBuilding: 40,
  // The contractor's confirmed profile lists the trade (+) or lists others but not this one (-).
  tradeCovered: 20,
  tradeNotCovered: -20,
  // Confirmed regions include the building's recorded region (+), or are recorded and exclude it (-).
  // The mismatch is the heavier because a contractor who does not travel there cannot take the job.
  regionMatch: 15,
  regionMismatch: -30,
  // Knowing the building (access, plant rooms, keys) saves a visit. Capped so a busy
  // contractor cannot outweigh the explicit statements above.
  maxJobsHere: 5,
  perJobHere: 4,
  // Recent work in the trade, anywhere, shows they are active in it; weaker than knowing the site.
  maxJobsTrade: 5,
  perJobTrade: 2,
  // Quote acceptance over the last 12 months, scaled 0 to this, once enough quotes are decided
  // that one win is not "100%".
  minDecidedQuotes: 3,
  quoteAcceptance: 10,
  // Median time to finish is noisy (a lift is not a light globe), so the reward is small and
  // there is no penalty for slower contractors.
  fastCompletion: [
    { atMostDays: 7, points: 4 },
    { atMostDays: 14, points: 2 },
  ],
  // Certificate of currency. A valid one is a small plus; the rest lower the score by how much
  // they should worry whoever is choosing. Expired is the worst: it is the one a manager would
  // otherwise have to go and find out.
  certificate: { expired: -25, expiring: -5, missing: -15, unknown: -5, valid: 5 },
} as const;

/** At most this many reasons that raise the score are shown; every caution always is. */
export const MAX_POSITIVE_REASONS = 4;

interface Component {
  caution?: boolean;
  points: number;
  text: string;
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

function certificateText(features: FeatureVector): string {
  const days = features.certificateDaysToExpiry;
  switch (features.certificateStatus) {
    case "missing":
      return "No certificate of currency recorded";
    case "unknown":
      return "Certificate of currency has no expiry date recorded";
    case "expired": {
      const ago = Math.abs(days ?? 0);
      return ago === 0 ? "Certificate of currency expired today" : `Certificate of currency expired ${plural(ago, "day", "days")} ago`;
    }
    case "expiring":
      return days === 0 ? "Certificate of currency expires today" : `Certificate of currency expires in ${plural(days ?? 0, "day", "days")}`;
    default:
      return `Certificate of currency is current, expires in ${plural(days ?? 0, "day", "days")}`;
  }
}

/** Every rule that applies to this candidate, with its points and sentence. Exported so the tests can read the arithmetic. */
export function componentsFor(features: FeatureVector, context: SuggestionContext): Component[] {
  const w = RULES_V1_WEIGHTS;
  const { trade, buildingRegion } = context;
  const out: Component[] = [];

  if (features.assignedToBuilding && trade) out.push({ points: w.assignedToBuilding, text: `Assigned to this building for ${trade}` });

  const covers = features.tradeCovered === true && trade;
  const services = features.regionMatch === true && buildingRegion;
  if (covers && services) out.push({ points: w.tradeCovered + w.regionMatch, text: `Covers ${trade} in ${buildingRegion}` });
  else if (covers) out.push({ points: w.tradeCovered, text: `Covers ${trade}` });
  else if (services) out.push({ points: w.regionMatch, text: `Services ${buildingRegion}` });
  if (features.tradeCovered === false && trade) out.push({ caution: true, points: w.tradeNotCovered, text: `${trade} is not one of their recorded trades` });
  if (features.regionMatch === false && buildingRegion) out.push({ caution: true, points: w.regionMismatch, text: `Not recorded as servicing ${buildingRegion}` });

  if (features.jobsHere12m > 0) {
    out.push({
      points: Math.min(features.jobsHere12m, w.maxJobsHere) * w.perJobHere,
      text: `${plural(features.jobsHere12m, "job", "jobs")} here in the last 12 months`,
    });
  }
  if (features.jobsTrade12m > 0 && trade) {
    out.push({
      points: Math.min(features.jobsTrade12m, w.maxJobsTrade) * w.perJobTrade,
      text: `${plural(features.jobsTrade12m, `${trade} job`, `${trade} jobs`)} in the last 12 months`,
    });
  }
  if (features.quoteAcceptanceRate12m !== null && features.quotesDecided12m >= w.minDecidedQuotes) {
    out.push({
      points: features.quoteAcceptanceRate12m * w.quoteAcceptance,
      text: `Quotes accepted ${features.quotesAccepted12m} of ${features.quotesDecided12m} times in the last 12 months`,
    });
  }
  const median = features.medianDaysToComplete12m;
  const fast = median === null ? undefined : w.fastCompletion.find((band) => median <= band.atMostDays);
  if (fast && median !== null) out.push({ points: fast.points, text: `Usually finishes jobs in ${plural(Math.max(1, Math.round(median)), "day", "days")}` });

  const certificatePoints = w.certificate[features.certificateStatus];
  out.push({ caution: certificatePoints < 0, points: certificatePoints, text: certificateText(features) });
  return out;
}

/** Positive evidence for this job: without any, the contractor is not suggested. */
export function hasEvidence(features: FeatureVector): boolean {
  return features.assignedToBuilding || features.tradeCovered === true || features.jobsHere12m > 0 || features.jobsTrade12m > 0;
}

function reasonsFrom(components: readonly Component[]): Reason[] {
  const positives = components
    .filter((component) => !component.caution)
    .sort((a, b) => b.points - a.points)
    .slice(0, MAX_POSITIVE_REASONS);
  const cautions = components.filter((component) => component.caution);
  return [...positives, ...cautions].map(({ caution, text }) => ({ caution: caution === true, text }));
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

function byBest(a: ScoredCandidate, b: ScoredCandidate): number {
  return (
    b.score - a.score ||
    b.features.jobsHere12m - a.features.jobsHere12m ||
    a.name.localeCompare(b.name, "en-AU") ||
    a.contractorId - b.contractorId
  );
}

// `satisfies` rather than `: Ranker`, so the rules ranker stays synchronous for callers that know it is.
export const rulesRanker = {
  rank(candidates: readonly Candidate[], context: SuggestionContext): ScoredCandidate[] {
    return candidates
      .filter((candidate) => hasEvidence(candidate.features))
      .map((candidate) => {
        const components = componentsFor(candidate.features, context);
        return {
          contractorId: candidate.contractorId,
          features: candidate.features,
          name: candidate.name,
          reasons: reasonsFrom(components),
          score: round2(components.reduce((total, component) => total + component.points, 0)),
        };
      })
      .sort(byBest);
  },
  version: "rules@1",
} satisfies Ranker;
