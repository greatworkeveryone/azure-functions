// Inbound email triage (EB3): rules ranker v1, "rules@1". A sum of points, each point with the
// sentence a person reads beside the name, so nobody has to trust a number they cannot explain. It
// is the baseline a learned or LLM ranker has to beat (see scripts/eval-triage-ranker.cjs), and it
// works before there is any history: the send being answered, a job named in the email and who
// holds the work at that building carry it.
//
// Rules:
// - The strongest evidence is a deliberate act: they sent the message being answered, or the job
//   the email names is theirs. History (jobs at this building, open work for this tenancy) comes
//   next; the role only breaks ties between people who are equal on the evidence.
// - Everyone eligible is ranked, so a manager always has three names to choose from even when
//   nothing speaks for anyone; a candidate with no evidence scores only their role fit.
// - Being busy lowers a score a little and is shown as a caution; it never removes anyone.

import type { Candidate, FeatureVector, Ranker, Reason, ScoredCandidate, TriageContext } from "./types";

/** Judgement, not fitted: the right order of magnitude so a deliberate act outweighs history and history outweighs the role. */
export const RULES_V1_WEIGHTS = {
  sentLinkedSend: 60,
  ownsNamedJob: 50,
  ownsOpenJobForTenancy: 30,
  ownsOpenJobHere: 12,
  // Recent jobs at this building in this category, then in any category. Capped so one busy person cannot outweigh a deliberate act.
  maxJobsHereCategory: 5,
  perJobHereCategory: 6,
  maxJobsHere: 5,
  perJobHere: 2,
  roleFit: { either_manager: 3, either_staff: 8, lane_manager: 6, lane_staff: 15, none: 0 },
  // A heavy open workload lowers the score by a point per job over this, up to the cap.
  busyOver: 10,
  maxBusyPenalty: 10,
} as const;

/** At most this many reasons that raise the score are shown; a caution always is. */
export const MAX_POSITIVE_REASONS = 4;

interface Component {
  caution?: boolean;
  points: number;
  text: string;
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** Every rule that applies to this candidate, with its points and sentence. Exported so the tests can read the arithmetic. */
export function componentsFor(features: FeatureVector, context: TriageContext): Component[] {
  const w = RULES_V1_WEIGHTS;
  const out: Component[] = [];
  const where = context.buildingName ? ` at ${context.buildingName}` : " at this building";

  if (features.sentLinkedSend) out.push({ points: w.sentLinkedSend, text: "Sent the message this is a reply to" });
  if (features.ownsNamedJob && context.matchedJobId !== null) out.push({ points: w.ownsNamedJob, text: `Is assigned job #${context.matchedJobId}, which this email names` });
  if (features.ownsOpenJobForTenancy) out.push({ points: w.ownsOpenJobForTenancy, text: `Has an open job for ${context.tenancyName ?? "this tenancy"}` });
  if (features.ownsOpenJobHere) out.push({ points: w.ownsOpenJobHere, text: `Has an open job${where}` });

  if (features.jobsHereCategory90d > 0 && context.category) {
    out.push({
      points: Math.min(features.jobsHereCategory90d, w.maxJobsHereCategory) * w.perJobHereCategory,
      text: `${plural(features.jobsHereCategory90d, `${context.category} job`, `${context.category} jobs`)}${where} in the last 90 days`,
    });
  }
  const otherJobs = features.jobsHere90d - features.jobsHereCategory90d;
  if (otherJobs > 0) {
    const label = context.category ? ["other job", "other jobs"] : ["job", "jobs"];
    out.push({ points: Math.min(otherJobs, w.maxJobsHere) * w.perJobHere, text: `${plural(otherJobs, label[0], label[1])}${where} in the last 90 days` });
  }

  const fit = w.roleFit[features.roleFit];
  if (fit > 0) {
    const text = context.lane === "facilities" ? "Works on maintenance" : context.lane === "accounts" ? "Works on accounts" : "Works on maintenance or accounts";
    out.push({ points: fit, text: features.roleFit.endsWith("manager") ? text.replace("Works on", "Manages") : text });
  }

  const over = features.openJobs - w.busyOver;
  if (over > 0) out.push({ caution: true, points: -Math.min(over, w.maxBusyPenalty), text: `Already has ${plural(features.openJobs, "open job", "open jobs")}` });
  return out;
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

// Ties go to whoever has less open work, then by name, so the order never depends on the order people were loaded in.
function byBest(a: ScoredCandidate, b: ScoredCandidate): number {
  return b.score - a.score || a.features.openJobs - b.features.openJobs || a.name.localeCompare(b.name, "en-AU") || a.userId - b.userId;
}

// `satisfies` rather than `: Ranker`, so the rules ranker stays synchronous for callers that know it is.
export const rulesRanker = {
  rank(candidates: readonly Candidate[], context: TriageContext): ScoredCandidate[] {
    return candidates
      .map((candidate) => {
        const components = componentsFor(candidate.features, context);
        return {
          features: candidate.features,
          name: candidate.name,
          reasons: reasonsFrom(components),
          role: candidate.role,
          score: round2(components.reduce((total, component) => total + component.points, 0)),
          userId: candidate.userId,
        };
      })
      .sort(byBest);
  },
  version: "rules@1",
} satisfies Ranker;
