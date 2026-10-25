// Contractor suggestions (SC-AI3): judging a ranker offline, from the log alone.
// Pure: scripts/eval-contractor-ranker.cjs reads the three tables (it only ever
// SELECTs) and hands the rows here. Nothing in this file touches a database.
//
// Definitions (each is a share of sets, never of contractors):
//   answered   a set with at least one chosen contractor. A dismissed set and a set
//              nobody answered are left out of every hit measure.
//   hit@k      answered sets where a chosen contractor held rank k or better. A set
//              that suggested nobody counts as a miss: the ranker had nothing to say.
//   mrr        mean of 1 / (best rank among the chosen), 0 when none was suggested.
//   coverage   sets that suggested at least one contractor, of all sets (answered or not).
// Sets are never pooled across ranker versions or feature schema versions.

import type { FeatureVector, Ranker, SuggestionContext, SuggestionContextKind } from "./types";

export const HIT_KS = [1, 3, 5] as const;

export interface LoggedSetItem {
  contractorId: number;
  features: FeatureVector;
  rank: number;
  score: number;
}

export interface LoggedSetOutcome {
  chosenContractorId: number | null;
  chosenFeatures: FeatureVector | null;
  chosenRank: number | null;
  outcome: "chose_suggested" | "chose_other" | "dismissed";
}

export interface LoggedSetRecord {
  buildingId: number;
  candidateCount: number;
  context: SuggestionContextKind;
  createdAt: string;
  featureSchemaVersion: string;
  isTest: boolean;
  items: LoggedSetItem[];
  jobId: number | null;
  outcomes: LoggedSetOutcome[];
  rankerVersion: string;
  setId: number;
  trade: string | null;
}

// ── Reading the rows ─────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function json<T>(text: unknown): T | null {
  try {
    return typeof text === "string" ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

const num = (value: unknown): number => Number(value);

/** Joins the three tables' rows into sets. A row whose JSON no longer parses is dropped, not guessed at. */
export function assembleSets(setRows: readonly Row[], itemRows: readonly Row[], outcomeRows: readonly Row[]): LoggedSetRecord[] {
  const sets = new Map<number, LoggedSetRecord>();
  for (const row of setRows) {
    sets.set(num(row.SetId), {
      buildingId: num(row.BuildingId),
      candidateCount: num(row.CandidateCount),
      context: row.Context as SuggestionContextKind,
      createdAt: row.CreatedAt instanceof Date ? row.CreatedAt.toISOString() : String(row.CreatedAt),
      featureSchemaVersion: String(row.FeatureSchemaVersion),
      isTest: row.IsTest === true || row.IsTest === 1,
      items: [],
      jobId: row.JobId === null || row.JobId === undefined ? null : num(row.JobId),
      outcomes: [],
      rankerVersion: String(row.RankerVersion),
      setId: num(row.SetId),
      trade: (row.Trade as string | null) ?? null,
    });
  }
  for (const row of itemRows) {
    const features = json<FeatureVector>(row.FeaturesJson);
    if (features) sets.get(num(row.SetId))?.items.push({ contractorId: num(row.ContractorId), features, rank: num(row.Rank), score: num(row.Score) });
  }
  for (const row of outcomeRows) {
    sets.get(num(row.SetId))?.outcomes.push({
      chosenContractorId: row.ChosenContractorId === null || row.ChosenContractorId === undefined ? null : num(row.ChosenContractorId),
      chosenFeatures: json<FeatureVector>(row.ChosenFeaturesJson),
      chosenRank: row.ChosenRank === null || row.ChosenRank === undefined ? null : num(row.ChosenRank),
      outcome: row.Outcome as LoggedSetOutcome["outcome"],
    });
  }
  for (const set of sets.values()) set.items.sort((a, b) => a.rank - b.rank);
  return [...sets.values()].sort((a, b) => a.setId - b.setId);
}

// ── Metrics ──────────────────────────────────────────────────────────────────

export interface Metrics {
  counts: {
    answered: number;
    choices: number;
    choicesOther: number;
    choicesSuggested: number;
    dismissed: number;
    sets: number;
    setsEmpty: number;
    setsWithSuggestions: number;
    unanswered: number;
  };
  coverage: number | null;
  hitAt: Record<string, number | null>;
  mrr: number | null;
}

const share = (part: number, whole: number): number | null => (whole === 0 ? null : Math.round((part / whole) * 10_000) / 10_000);

const chosenOf = (set: LoggedSetRecord): LoggedSetOutcome[] => set.outcomes.filter((outcome) => outcome.chosenContractorId !== null);

/** The best rank held by anyone chosen in this set, as the log recorded it; null when none was suggested. */
function bestChosenRank(set: LoggedSetRecord): number | null {
  const ranks = chosenOf(set)
    .map((outcome) => outcome.chosenRank)
    .filter((rank): rank is number => rank !== null);
  return ranks.length === 0 ? null : Math.min(...ranks);
}

/** Metrics for sets as logged, or with `rankOf` giving each answered set's best chosen rank under another ordering. */
export function metricsFor(sets: readonly LoggedSetRecord[], rankOf: (set: LoggedSetRecord) => number | null = bestChosenRank): Metrics {
  const answeredSets = sets.filter((set) => chosenOf(set).length > 0);
  const ranks = answeredSets.map(rankOf);
  const choices = answeredSets.flatMap(chosenOf);
  const withSuggestions = sets.filter((set) => set.items.length > 0).length;
  return {
    counts: {
      answered: answeredSets.length,
      choices: choices.length,
      choicesOther: choices.filter((choice) => choice.outcome === "chose_other").length,
      choicesSuggested: choices.filter((choice) => choice.outcome === "chose_suggested").length,
      dismissed: sets.filter((set) => chosenOf(set).length === 0 && set.outcomes.some((outcome) => outcome.outcome === "dismissed")).length,
      sets: sets.length,
      setsEmpty: sets.length - withSuggestions,
      setsWithSuggestions: withSuggestions,
      unanswered: sets.filter((set) => set.outcomes.length === 0).length,
    },
    coverage: share(withSuggestions, sets.length),
    hitAt: Object.fromEntries(HIT_KS.map((k) => [String(k), share(ranks.filter((rank) => rank !== null && rank <= k).length, answeredSets.length)])),
    mrr: answeredSets.length === 0 ? null : Math.round((ranks.reduce<number>((total, rank) => total + (rank === null ? 0 : 1 / rank), 0) / answeredSets.length) * 10_000) / 10_000,
  };
}

export interface GroupReport {
  byContext: Partial<Record<SuggestionContextKind, Metrics>>;
  featureSchemaVersion: string;
  overall: Metrics;
  rankerVersion: string;
}

function groupKey(set: LoggedSetRecord): string {
  return `${set.rankerVersion}\u0000${set.featureSchemaVersion}`;
}

/** One report per (ranker version, feature schema version), each with its per-context breakdown. */
export function evaluate(sets: readonly LoggedSetRecord[]): GroupReport[] {
  const groups = new Map<string, LoggedSetRecord[]>();
  for (const set of sets) groups.set(groupKey(set), [...(groups.get(groupKey(set)) ?? []), set]);
  return [...groups.values()]
    .map((members) => {
      const byContext: GroupReport["byContext"] = {};
      for (const context of [...new Set(members.map((set) => set.context))].sort()) {
        byContext[context] = metricsFor(members.filter((set) => set.context === context));
      }
      return {
        byContext,
        featureSchemaVersion: members[0].featureSchemaVersion,
        overall: metricsFor(members),
        rankerVersion: members[0].rankerVersion,
      };
    })
    .sort((a, b) => a.rankerVersion.localeCompare(b.rankerVersion) || a.featureSchemaVersion.localeCompare(b.featureSchemaVersion));
}

// ── Training rows ────────────────────────────────────────────────────────────

export interface TrainingRow {
  buildingId: number;
  contractorId: number;
  context: SuggestionContextKind;
  createdAt: string;
  features: FeatureVector;
  featureSchemaVersion: string;
  jobId: number | null;
  /** 1 when the person chose this contractor, 0 when they were shown it and chose otherwise. */
  label: 0 | 1;
  /** Rank in the set; null for a contractor chosen without being suggested. */
  rank: number | null;
  rankerVersion: string;
  score: number | null;
  /** "dismissed": the person chose nobody, so every contractor shown is a negative. */
  setAnswer: "chose" | "dismissed";
  setId: number;
  /** False for a contractor chosen without being suggested: a positive the ranker never showed. */
  suggested: boolean;
  trade: string | null;
}

/**
 * One row per contractor on every set a person answered, labelled by what they
 * did, plus one positive per contractor chosen without being suggested (when their
 * features were captured). Sets nobody answered have no label and are left out.
 */
export function trainingRows(sets: readonly LoggedSetRecord[]): TrainingRow[] {
  const rows: TrainingRow[] = [];
  for (const set of sets) {
    if (set.outcomes.length === 0) continue;
    const chosen = new Set(chosenOf(set).map((outcome) => outcome.chosenContractorId));
    const setAnswer: TrainingRow["setAnswer"] = chosenOf(set).length > 0 ? "chose" : "dismissed";
    const common = {
      buildingId: set.buildingId,
      context: set.context,
      createdAt: set.createdAt,
      featureSchemaVersion: set.featureSchemaVersion,
      jobId: set.jobId,
      rankerVersion: set.rankerVersion,
      setAnswer,
      setId: set.setId,
      trade: set.trade,
    };
    for (const item of set.items) {
      rows.push({ ...common, contractorId: item.contractorId, features: item.features, label: chosen.has(item.contractorId) ? 1 : 0, rank: item.rank, score: item.score, suggested: true });
    }
    for (const outcome of chosenOf(set)) {
      if (outcome.chosenRank !== null || !outcome.chosenFeatures) continue;
      rows.push({ ...common, contractorId: outcome.chosenContractorId as number, features: outcome.chosenFeatures, label: 1, rank: null, score: null, suggested: false });
    }
  }
  return rows;
}

// ── Replay ───────────────────────────────────────────────────────────────────

export interface ReplayReport {
  /** The same sets scored as logged, so the two sit side by side on identical traffic. */
  baseline: Metrics;
  replayed: Metrics;
  sets: number;
}

const DARWIN_OFFSET_MS = 9.5 * 3_600_000;

/**
 * Re-ranks every answered set with `ranker` and measures where the chosen contractor
 * lands. The candidates are those the person was shown plus any they chose without
 * being shown, so this can only reorder what was on record: it favours a ranker that
 * orders those well and says nothing about contractors never suggested. Region is not
 * logged with a set, so a ranker replays without it. A ranker that needs more than the
 * logged features has to be judged on live traffic instead.
 */
export async function replay(sets: readonly LoggedSetRecord[], ranker: Ranker): Promise<ReplayReport> {
  const answered = sets.filter((set) => chosenOf(set).length > 0);
  const replayedRank = new Map<number, number | null>();
  for (const set of answered) {
    const candidates = [
      ...set.items.map((item) => ({ contractorId: item.contractorId, features: item.features, name: `Contractor #${item.contractorId}` })),
      ...chosenOf(set)
        .filter((outcome) => outcome.chosenRank === null && outcome.chosenFeatures)
        .map((outcome) => ({ contractorId: outcome.chosenContractorId as number, features: outcome.chosenFeatures as FeatureVector, name: `Contractor #${outcome.chosenContractorId}` })),
    ];
    const context: SuggestionContext = {
      buildingId: set.buildingId,
      buildingRegion: null,
      context: set.context,
      jobId: set.jobId,
      today: new Date(Date.parse(set.createdAt) + DARWIN_OFFSET_MS).toISOString().slice(0, 10),
      trade: set.trade,
    };
    const order = (await ranker.rank(candidates, context)).map((item) => item.contractorId);
    const positions = chosenOf(set)
      .map((outcome) => order.indexOf(outcome.chosenContractorId as number) + 1)
      .filter((position) => position > 0);
    replayedRank.set(set.setId, positions.length === 0 ? null : Math.min(...positions));
  }
  return {
    baseline: metricsFor(answered),
    replayed: metricsFor(answered, (set) => replayedRank.get(set.setId) ?? null),
    sets: answered.length,
  };
}

// ── Command line ─────────────────────────────────────────────────────────────

export const EVAL_USAGE = `Usage: node scripts/eval-contractor-ranker.cjs [options]

Reads the contractor suggestion log (sets, items, outcomes) and reports hit@1, hit@3,
hit@5, mean reciprocal rank, coverage and counts per ranker version. It only reads.

  --target <server>/<database>  default localhost/floorplan_review (the local review database)
  --allow-remote                required for any server that is not localhost, 127.0.0.1 or ::1;
                                then connects with your \`az login\` identity
  --since <YYYY-MM-DD>          only sets created on or after this date (UTC)
  --include-test                include sets made on test records (left out by default)
  --ranker <version>            only sets suggested by this ranker version, e.g. rules@1
  --json                        print the report as JSON
  --export <file.jsonl>         also write one training row per contractor per answered set
  --replay <module>             re-rank the logged sets with a compiled ranker module (it
                                exports \`ranker\`, or a default export) beside the logged result`;

export interface EvalArgs {
  allowRemote: boolean;
  export: string | null;
  help: boolean;
  includeTest: boolean;
  json: boolean;
  ranker: string | null;
  replay: string | null;
  since: string | null;
  target: string | null;
}

export function parseEvalArgs(argv: readonly string[]): EvalArgs {
  const args: EvalArgs = { allowRemote: false, export: null, help: false, includeTest: false, json: false, ranker: null, replay: null, since: null, target: null };
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
    else if (arg === "--replay") args.replay = value(i++, arg);
    else throw new Error(`Unknown option ${arg}\n\n${EVAL_USAGE}`);
  }
  if (args.since !== null && !/^\d{4}-\d{2}-\d{2}$/.test(args.since)) throw new Error("--since must be a date, YYYY-MM-DD");
  return args;
}

export const DEFAULT_EVAL_TARGET = "localhost/floorplan_review";

/** The server's host without a protocol prefix or port, lower-cased: "tcp:Localhost,1433" is "localhost". */
function hostOf(server: string): string {
  const bare = server.trim().toLowerCase().replace(/^tcp:/, "");
  if (bare.startsWith("[")) return bare.slice(0, bare.indexOf("]") + 1);
  if ((bare.match(/:/g) ?? []).length > 1) return bare;
  return bare.split(/[,:]/)[0];
}

/** Only the machine's own loopback names: a lookalike such as localhost.example.com is not local. */
export function isLocalServer(server: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostOf(server));
}

export interface EvalTarget {
  database: string;
  isLocal: boolean;
  server: string;
}

export function resolveEvalTarget(args: Pick<EvalArgs, "allowRemote" | "target">): EvalTarget {
  const raw = args.target ?? DEFAULT_EVAL_TARGET;
  const slash = raw.lastIndexOf("/");
  const server = raw.slice(0, slash).trim();
  const database = raw.slice(slash + 1).trim();
  if (slash === -1 || !server || !database) throw new Error(`--target must be <server>/<database>, got "${raw}".`);
  const isLocal = isLocalServer(server);
  if (!isLocal && !args.allowRemote) {
    throw new Error(`Refusing to read ${server}: it is not localhost. This script defaults to the local review database; pass --allow-remote to read another server on purpose.`);
  }
  return { database, isLocal, server };
}
