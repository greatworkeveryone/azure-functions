// The tenant-facing status timeline (TR3): four steps, as PLAN §15 sets the protocol:
// received (automatic) -> acknowledged and being assessed (a staff click) -> attendance booked ->
// completed. A request raised in Floorplan (negative id) is driven by its intake state (intake/state.ts) and
// the job raised from it: "Attendance booked" is the job reaching Work, the same moment the TR4 attendance notice
// fires, and "Completed" is the job completing (the same isWorkCompletion test). The status-text regex is only
// the fallback for myBuildings-origin rows, which have no Floorplan job. A closed request (duplicate, not ours,
// cancelled) says "closed" and nothing more: no internal reason is shown.

import { isClosed, storedState } from "../intake/state";

export type StageKey = "received" | "acknowledged" | "booked" | "completed";

export interface TimelineStep {
  at: string | null;
  key: StageKey;
  label: string;
  reached: boolean;
}

export interface Timeline {
  closed: boolean;
  current: StageKey;
  steps: TimelineStep[];
}

const LABELS: Record<StageKey, string> = {
  acknowledged: "Acknowledged, being assessed",
  booked: "Attendance booked",
  completed: "Completed",
  received: "Received",
};
const ORDER: StageKey[] = ["received", "acknowledged", "booked", "completed"];

const text = (value: unknown): string => (typeof value === "string" ? value.toLowerCase().replace(/[\s_-]+/g, " ").trim() : "");

function stageFrom(intakeState: string, status: string): { closed: boolean; stage: StageKey } {
  const both = `${intakeState} | ${status}`;
  if (/\b(complete|completed|done|resolved|finished)\b/.test(both)) return { closed: false, stage: "completed" };
  if (/\b(duplicate|not ours|closed|cancelled|canceled|declined|rejected)\b/.test(both)) return { closed: true, stage: "acknowledged" };
  if (/\b(booked|scheduled|job raised|assigned|in progress|attending|work in progress|approved)\b/.test(both)) return { closed: false, stage: "booked" };
  if (/\b(acknowledged|assessing|assessment|being assessed|on hold|awaiting)\b/.test(both)) return { closed: false, stage: "acknowledged" };
  return { closed: false, stage: "received" };
}

/** What the jobs raised from a request say (tenantPage/list.ts): any job, any at Work or later, all complete. */
export interface JobFacts {
  allComplete: boolean;
  anyBooked: boolean;
  hasJob: boolean;
}

function stageFromIntake(intakeState: unknown, job: JobFacts | null): { closed: boolean; stage: StageKey } {
  if (job?.hasJob) return { closed: false, stage: job.allComplete ? "completed" : job.anyBooked ? "booked" : "acknowledged" };
  const state = storedState(intakeState);
  if (isClosed(state)) return { closed: true, stage: "acknowledged" };
  return { closed: false, stage: state === "received" ? "received" : "acknowledged" };
}

export function timelineFor(input: { completedAt: unknown; intakeState: unknown; job?: JobFacts | null; native?: boolean; status: unknown; submittedAt: Date }): Timeline {
  const { closed, stage } = input.native || input.job?.hasJob ? stageFromIntake(input.intakeState, input.job ?? null) : stageFrom(text(input.intakeState), text(input.status));
  const reachedIndex = ORDER.indexOf(stage);
  const completedAt = typeof input.completedAt === "string" && !Number.isNaN(Date.parse(input.completedAt)) ? new Date(input.completedAt).toISOString() : null;
  return {
    closed,
    current: stage,
    steps: ORDER.map((key, index) => ({
      // Only the two times the database really holds are shown; the middle steps carry no invented time.
      at: key === "received" ? input.submittedAt.toISOString() : key === "completed" && index <= reachedIndex ? completedAt : null,
      key,
      label: LABELS[key],
      reached: index <= reachedIndex,
    })),
  };
}
