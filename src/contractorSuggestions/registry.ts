// Contractor suggestions (SC-AI3): which ranker answers. Callers ask for "the
// active ranker" and never name one, so a learned or LLM ranker is added by
// writing its file and listing it here, and chosen by the CONTRACTOR_RANKER
// app setting. See docs/runbooks/switches.md.

import { rulesRanker } from "./rulesRanker";
import type { Ranker } from "./types";

/** Register new rankers here, keyed by the value CONTRACTOR_RANKER takes. */
export const RANKERS: Readonly<Record<string, Ranker>> = {
  rules: rulesRanker,
};

export const DEFAULT_RANKER = "rules";

export interface ResolvedRanker {
  /** True when the setting named a ranker that is not registered and the default answered instead. */
  fellBack: boolean;
  ranker: Ranker;
  /** What the setting said, trimmed and lower-cased; the default when it was unset. */
  requested: string;
}

/**
 * The ranker the environment asks for. An unset setting means the default. A
 * setting that names nothing registered falls back to the default and says so,
 * because a typo in an app setting must not switch suggestions off or change
 * who is suggested to something nobody chose.
 */
export function resolveRanker(
  env: Record<string, string | undefined> = process.env,
  registry: Readonly<Record<string, Ranker>> = RANKERS,
): ResolvedRanker {
  const requested = (env.CONTRACTOR_RANKER ?? "").trim().toLowerCase() || DEFAULT_RANKER;
  const found = Object.prototype.hasOwnProperty.call(registry, requested) ? registry[requested] : undefined;
  if (found) return { fellBack: false, ranker: found, requested };
  return { fellBack: true, ranker: registry[DEFAULT_RANKER], requested };
}
