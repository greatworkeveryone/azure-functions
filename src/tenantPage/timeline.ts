// The tenant-facing status timeline (TR3): four steps, as PLAN §15 sets the protocol:
// received (automatic) -> acknowledged and being assessed (a staff click) -> attendance booked ->
// completed. It is derived from WorkRequests.IntakeState when TR1's column exists, otherwise from
// the request's existing status text. A closed request (duplicate, not ours, cancelled) says "closed"
// and nothing more: no internal reason is shown.

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

export function timelineFor(input: { completedAt: unknown; intakeState: unknown; status: unknown; submittedAt: Date }): Timeline {
  const { closed, stage } = stageFrom(text(input.intakeState), text(input.status));
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
