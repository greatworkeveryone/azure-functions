// Intake state of a work request (TR1, PLAN §15). Received → Acknowledged → Assessing → job raised, or closed
// as a duplicate / not ours. The frontend mirrors this in src/helpers/intakeState.ts: change both together.
//
// Stored: dbo.WorkRequests.IntakeState (NULL reads as received). "Job raised" is never stored, it is whether a
// Job points at the request, so the two cannot disagree.

export const INTAKE_STATES = ["received", "acknowledged", "assessing", "closed_duplicate", "closed_not_ours"] as const;
export type IntakeState = (typeof INTAKE_STATES)[number];

/** What a request shows as: a stored state, or converted once a job has been raised from it. */
export type IntakeView = IntakeState | "converted";

export const INTAKE_PRIORITIES = ["Critical", "High", "Normal", "Low"] as const;
export type IntakePriority = (typeof INTAKE_PRIORITIES)[number];

/** Acknowledging is its own step (it tells the tenant); assessing follows it; either close can happen from any open state. */
const MOVES: Record<IntakeState, readonly IntakeState[]> = {
  acknowledged: ["assessing", "closed_duplicate", "closed_not_ours"],
  assessing: ["closed_duplicate", "closed_not_ours"],
  closed_duplicate: [],
  closed_not_ours: [],
  received: ["acknowledged", "closed_duplicate", "closed_not_ours"],
};

export const isIntakeState = (value: unknown): value is IntakeState => typeof value === "string" && (INTAKE_STATES as readonly string[]).includes(value);

/** NULL (a request from before intake existed, or one the sync just made) is received. */
export const storedState = (raw: unknown): IntakeState => (isIntakeState(raw) ? raw : "received");

export const canMove = (from: IntakeState, to: IntakeState): boolean => MOVES[from].includes(to);

export const isClosed = (state: IntakeState): boolean => state === "closed_duplicate" || state === "closed_not_ours";

export function viewState(raw: unknown, hasJob: boolean): IntakeView {
  return hasJob ? "converted" : storedState(raw);
}

/** What the tenant page's urgency is stored as (tenantPage/constants URGENCY_PRIORITY) and the target it counts against. */
const TENANT_URGENCY_TARGET: Record<string, IntakePriority> = { emergency: "Critical", routine: "Normal", urgent: "High" };

/** A request's priority as the targets table keys it; a tenant's Emergency/Urgent/Routine map to Critical/High/Normal; anything unrecognised counts as Normal. */
export function intakePriority(raw: unknown): IntakePriority {
  const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (text in TENANT_URGENCY_TARGET) return TENANT_URGENCY_TARGET[text];
  return INTAKE_PRIORITIES.find((priority) => priority.toLowerCase() === text) ?? "Normal";
}

export const MAX_CLOSE_REASON_CHARS = 300;
