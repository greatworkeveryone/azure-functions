// Tidy job titles (SC-AI6): the text a model is shown. tidyInspectionJobTitles builds it
// from a validated request; the purpose's validator and its mock read it back, so the
// layout lives here and nowhere else.
//
//   Job 1: Electrical: Level 2 kitchen and corridor (3 findings)
//   Finding: Light flickering
//   Job 2: Ground floor / Plant room
//
// How many jobs there are is what the input says, counted from its own lines: an answer
// must hold exactly that many titles, in that order. Nothing the browser sends can write
// a line of its own: every title and finding is cut to one line, and a finding's line
// always starts "Finding: ", so none can start a job.

/** Mirrored in the frontend (src/helpers/inspectionJobSuggestions): the browser cuts to these before it sends. */
export const TIDY_LIMITS = {
  findingChars: 300,
  /** What the purpose accepts in all; a request that builds to more is refused whole, never cut. */
  maxInputChars: 12_000,
  maxFindings: 8,
  maxTitles: 40,
  titleChars: 200,
} as const;

export interface TidyJob {
  findings: string[];
  title: string;
}

/** The answer's own brackets are refused, so none of the browser's text may invite one. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim().replace(/\[/g, "(").replace(/\]/g, ")");

export function buildTitlesInput(jobs: readonly TidyJob[]): string {
  return jobs
    .flatMap((job, index) => [`Job ${index + 1}: ${oneLine(job.title)}`, ...job.findings.map((finding) => `Finding: ${oneLine(finding)}`)])
    .join("\n");
}

/**
 * How many jobs the input says it holds: 0 when it is missing or not in this layout (jobs
 * numbered from 1, in order, no more than maxTitles), so a check that depends on it fails closed.
 */
export function jobCountOf(input: unknown): number {
  if (typeof input !== "string") return 0;
  const numbers = [...input.matchAll(/^Job (\d+): /gm)].map((found) => Number(found[1]));
  if (numbers.length === 0 || numbers.length > TIDY_LIMITS.maxTitles) return 0;
  return numbers.every((number, index) => number === index + 1) ? numbers.length : 0;
}

/** The jobs back out of an input built above, or null when it is not one (the mock then answers with no titles). */
export function readTitlesInput(input: string): TidyJob[] | null {
  if (jobCountOf(input) === 0) return null;
  const jobs: TidyJob[] = [];
  for (const line of input.split("\n")) {
    const job = line.match(/^Job \d+: (.*)$/);
    if (job) jobs.push({ findings: [], title: job[1] });
    else if (line.startsWith("Finding: ") && jobs.length > 0) jobs[jobs.length - 1].findings.push(line.slice("Finding: ".length));
  }
  return jobs;
}
