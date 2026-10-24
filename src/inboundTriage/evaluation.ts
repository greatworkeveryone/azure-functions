// Inbound email triage (EB3): judging a ranker from its own log. Pure, so it is tested without a
// database; scripts/eval-triage-ranker.cjs reads the three log tables and hands the rows here.
//
// The label is the final owner: whoever the email ended up with, which is the last outcome logged for
// its set (an automatic assignment that a manager later reassigns is a miss for the ranker). A set
// is "answered" once it has any outcome; a queued set nobody has picked yet is not.
//
// Measures per ranker version and feature schema version (they are never mixed):
//   hit@1, hit@3  the final owner was ranked first, or in the top three (over answered sets)
//   mrr           mean of 1/rank of the final owner; 0 when they were not ranked
//   autoKept      automatic assignments the managers left alone, over all automatic ones
//   queuePicked   queued sets a manager answered, over all queued ones

import { resolveEvalTarget as resolveTarget } from "../contractorSuggestions/evaluation";
import type { FeatureVector, OutcomeKind } from "./types";

type Row = Record<string, unknown>;

export interface LoggedOutcome {
  chosenFeatures: FeatureVector | null;
  chosenRank: number | null;
  chosenUserId: number;
  outcome: OutcomeKind;
  previousUserId: number | null;
}

export interface LoggedItem {
  features: FeatureVector;
  rank: number;
  score: number;
  userId: number;
}

export interface LoggedSetRecord {
  decision: string;
  featureSchemaVersion: string;
  intent: string;
  items: LoggedItem[];
  lane: string;
  outcomes: LoggedOutcome[];
  rankerVersion: string;
  setId: number;
}

const parseFeatures = (json: unknown): FeatureVector => (typeof json === "string" ? (JSON.parse(json) as FeatureVector) : ({} as FeatureVector));

/** Joins the three tables' rows into one record per set; rows must come ordered by set (items by rank, outcomes by id). */
export function assembleSets(setRows: readonly Row[], itemRows: readonly Row[], outcomeRows: readonly Row[]): LoggedSetRecord[] {
  const sets = new Map<number, LoggedSetRecord>();
  for (const row of setRows) {
    sets.set(Number(row.SetId), {
      decision: String(row.Decision), featureSchemaVersion: String(row.FeatureSchemaVersion), intent: String(row.Intent), items: [], lane: String(row.Lane),
      outcomes: [], rankerVersion: String(row.RankerVersion), setId: Number(row.SetId),
    });
  }
  for (const row of itemRows) {
    sets.get(Number(row.SetId))?.items.push({ features: parseFeatures(row.FeaturesJson), rank: Number(row.Rank), score: Number(row.Score), userId: Number(row.CandidateUserId) });
  }
  for (const row of outcomeRows) {
    sets.get(Number(row.SetId))?.outcomes.push({
      chosenFeatures: row.ChosenFeaturesJson ? parseFeatures(row.ChosenFeaturesJson) : null,
      chosenRank: row.ChosenRank === null || row.ChosenRank === undefined ? null : Number(row.ChosenRank),
      chosenUserId: Number(row.ChosenUserId),
      outcome: row.Outcome as OutcomeKind,
      previousUserId: row.PreviousUserId === null || row.PreviousUserId === undefined ? null : Number(row.PreviousUserId),
    });
  }
  return [...sets.values()];
}

/** The last outcome's person and the rank the ranker gave them (null when it did not rank them); null when nobody has answered. */
export function finalOwner(set: LoggedSetRecord): { rank: number | null; userId: number } | null {
  const last = set.outcomes[set.outcomes.length - 1];
  if (!last) return null;
  const item = set.items.find((candidate) => candidate.userId === last.chosenUserId);
  return { rank: item?.rank ?? null, userId: last.chosenUserId };
}

export interface Metrics {
  answered: number;
  auto: number;
  autoKept: number | null;
  hitAt: { "1": number | null; "3": number | null };
  manual: number;
  mrr: number | null;
  queued: number;
  queuePicked: number | null;
  sets: number;
}

const ratio = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

export function metricsFor(sets: readonly LoggedSetRecord[]): Metrics {
  const owners = sets.map((set) => ({ owner: finalOwner(set), set })).filter((entry) => entry.owner !== null);
  const auto = sets.filter((set) => set.decision === "auto");
  const queued = sets.filter((set) => set.decision === "queued");
  const kept = auto.filter((set) => set.outcomes.length === 1);
  const rankOf = (entry: (typeof owners)[number]) => entry.owner?.rank ?? null;
  return {
    answered: owners.length,
    auto: auto.length,
    autoKept: ratio(kept.length, auto.length),
    hitAt: {
      "1": ratio(owners.filter((entry) => rankOf(entry) === 1).length, owners.length),
      "3": ratio(owners.filter((entry) => (rankOf(entry) ?? Infinity) <= 3).length, owners.length),
    },
    manual: sets.filter((set) => set.decision === "manual").length,
    mrr: ratio(owners.reduce((total, entry) => total + (rankOf(entry) ? 1 / (rankOf(entry) as number) : 0), 0), owners.length),
    queued: queued.length,
    queuePicked: ratio(queued.filter((set) => set.outcomes.length > 0).length, queued.length),
    sets: sets.length,
  };
}

export interface GroupReport {
  featureSchemaVersion: string;
  overall: Metrics;
  rankerVersion: string;
}

/** One report per ranker version on one feature schema, oldest version first. Manual sets (no ranker) are left out. */
export function evaluate(sets: readonly LoggedSetRecord[]): GroupReport[] {
  const groups = new Map<string, LoggedSetRecord[]>();
  for (const set of sets) {
    if (set.decision === "manual") continue;
    const key = `${set.rankerVersion}\u0000${set.featureSchemaVersion}`;
    groups.set(key, [...(groups.get(key) ?? []), set]);
  }
  return [...groups.entries()].map(([key, members]) => {
    const [rankerVersion, featureSchemaVersion] = key.split("\u0000");
    return { featureSchemaVersion, overall: metricsFor(members), rankerVersion };
  });
}

export interface TrainingRow {
  features: FeatureVector;
  featureSchemaVersion: string;
  label: boolean;
  rank: number | null;
  rankerVersion: string;
  setId: number;
  userId: number;
}

/** One row per ranked person per answered set (label: they became the owner), plus the owner's own row when they were not ranked. */
export function trainingRows(sets: readonly LoggedSetRecord[]): TrainingRow[] {
  return sets.flatMap((set) => {
    const owner = finalOwner(set);
    if (!owner) return [];
    const base = { featureSchemaVersion: set.featureSchemaVersion, rankerVersion: set.rankerVersion, setId: set.setId };
    const rows: TrainingRow[] = set.items.map((item) => ({ ...base, features: item.features, label: item.userId === owner.userId, rank: item.rank, userId: item.userId }));
    const extra = set.outcomes[set.outcomes.length - 1]?.chosenFeatures;
    if (owner.rank === null && extra) rows.push({ ...base, features: extra, label: true, rank: null, userId: owner.userId });
    return rows;
  });
}

export const EVAL_USAGE = `Usage: node scripts/eval-triage-ranker.cjs [options]

Reads the inbound triage log (sets, items, outcomes) and reports hit@1, hit@3, mean reciprocal rank,
how many automatic assignments were kept and how many queued emails a manager answered, per ranker
version. It only reads.

  --target <server>/<database>  default localhost/floorplan_review (the local review database)
  --allow-remote                required for any server that is not localhost, 127.0.0.1 or ::1;
                                then connects with your \`az login\` identity
  --since <YYYY-MM-DD>          only sets created on or after this date (UTC)
  --include-test                include sets made on test emails (left out by default)
  --ranker <version>            only sets ranked by this version, e.g. rules@1
  --json                        print the report as JSON
  --export <file.jsonl>         also write one training row per ranked person per answered set`;

export interface EvalArgs {
  allowRemote: boolean;
  export: string | null;
  help: boolean;
  includeTest: boolean;
  json: boolean;
  ranker: string | null;
  since: string | null;
  target: string | null;
}

export function parseEvalArgs(argv: readonly string[]): EvalArgs {
  const args: EvalArgs = { allowRemote: false, export: null, help: false, includeTest: false, json: false, ranker: null, since: null, target: null };
  const value = (index: number, name: string): string => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`${name} needs a value\n\n${EVAL_USAGE}`);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--allow-remote") args.allowRemote = true;
    else if (arg === "--include-test") args.includeTest = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--target") args.target = value(i++, arg);
    else if (arg === "--since") args.since = value(i++, arg);
    else if (arg === "--ranker") args.ranker = value(i++, arg);
    else if (arg === "--export") args.export = value(i++, arg);
    else throw new Error(`Unknown option ${arg}\n\n${EVAL_USAGE}`);
  }
  if (args.since !== null && !/^\d{4}-\d{2}-\d{2}$/.test(args.since)) throw new Error("--since must be a date, YYYY-MM-DD");
  return args;
}

/** The same rules as the contractor evaluation: the local review database unless --allow-remote says otherwise. */
export const resolveEvalTarget = resolveTarget;
