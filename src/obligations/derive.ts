// The pure end: from the loaded facts to one person's list. Dedupe (one row per thing, the most urgent group wins),
// a per-source cap with a truthful count of what the cap left out, and the totals every count in the app reads.

import { OBLIGATION_GROUPS, PER_SOURCE_CAP, type Candidate, type Obligation, type ObligationAnswer, type ObligationContext, type ObligationGroup, type SourceAdapter, type Viewer } from "./types";

const RANK: Record<ObligationGroup, number> = { decide: 0, do: 1, waiting: 2 };

const emptyCounts = (): Record<ObligationGroup, number> => ({ decide: 0, do: 0, waiting: 0 });

function byAge(a: Obligation, b: Obligation): number {
  return RANK[a.group] - RANK[b.group] || (a.waitingSince ?? "9999").localeCompare(b.waitingSince ?? "9999") || a.id.localeCompare(b.id);
}

/** One row per thing: the same quote or job from two sources is one row, in the group that asks most of the person. */
export function dedupe(candidates: readonly Candidate[]): Candidate[] {
  const best = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const kept = best.get(candidate.key);
    if (!kept || RANK[candidate.group] < RANK[kept.group]) best.set(candidate.key, candidate);
  }
  return [...best.values()];
}

export interface DerivedList {
  items: Obligation[];
  more: Record<ObligationGroup, number>;
  totals: Record<ObligationGroup, number>;
  unavailable: string[];
}

export function deriveObligations(
  sources: ReadonlyArray<{ adapter: SourceAdapter<unknown>; facts: unknown }>,
  viewer: Viewer,
  ctx: ObligationContext,
  unavailable: readonly string[] = [],
  cap: number = PER_SOURCE_CAP,
): DerivedList {
  const totals = emptyCounts();
  const more = emptyCounts();
  const shown: Candidate[] = [];
  const all = dedupe(sources.flatMap(({ adapter, facts }) => adapter.derive(facts, viewer, ctx)));
  const bySource = new Map<string, Candidate[]>();
  for (const candidate of all) {
    totals[candidate.group] += 1;
    bySource.set(candidate.kind, [...(bySource.get(candidate.kind) ?? []), candidate]);
  }
  for (const rows of bySource.values()) {
    for (const group of OBLIGATION_GROUPS) {
      const inGroup = rows.filter((row) => row.group === group).sort(byAge);
      shown.push(...inGroup.slice(0, cap));
      more[group] += Math.max(0, inGroup.length - cap);
    }
  }
  const items = shown.sort(byAge).map(({ key: _key, ...row }): Obligation => row);
  return { items, more, totals, unavailable: [...unavailable] };
}

/** The one number every count in the app reads: what is waiting on this person. */
export const waitingOnMe = (totals: Record<ObligationGroup, number>): number => totals.decide + totals.do;

export type { ObligationAnswer };
