// The one switch for Microsoft Planner writes.
//
// Planner is being retired (PLAN D21, Q16) and nothing new goes to it. Every code
// path that creates, updates or completes a Planner task asks plannerSyncEnabled()
// first and does nothing unless PLANNER_SYNC_ENABLED is exactly "true".
//
// APP_BASE_URL used to be the de facto switch: the Planner reconcilers skipped
// when it was unset. It now only builds links (escalation emails, director
// emails), so production can set it without turning Planner task creation back
// on through the job-save reconcile.
//
// Leave this module import-free: planner.ts, both reconcilers and both Planner
// entry points load it, and tests mock ./planner without supplying it.

export const PLANNER_SYNC_DISABLED_MESSAGE = 'Planner sync disabled (PLANNER_SYNC_ENABLED is not "true")';

let disabledLogged = false;

/**
 * True only when PLANNER_SYNC_ENABLED is exactly "true"; unset, "TRUE", "1" and
 * " true" are all off. When off, the first call in a process logs
 * PLANNER_SYNC_DISABLED_MESSAGE and later calls stay quiet, so a job save or the
 * nightly timer does not repeat it.
 */
export function plannerSyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PLANNER_SYNC_ENABLED === "true") return true;
  if (!disabledLogged) {
    disabledLogged = true;
    console.warn(PLANNER_SYNC_DISABLED_MESSAGE);
  }
  return false;
}

/**
 * True only when PLANNER_UNSIGNED_HOLDBACK_ENABLED is exactly "true". While it is off
 * the nightly timer raises no lease tasks for a tenancy whose schedule nobody has
 * signed off (PLAN D7), but leaves any already open alone: taking those down is a
 * bulk change to live Planner data, so it is opt-in. Independent of
 * PLANNER_SYNC_ENABLED: it only decides what the timer does once Planner is on.
 */
export function plannerUnsignedHoldbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PLANNER_UNSIGNED_HOLDBACK_ENABLED === "true";
}

/** Test-only: makes the next disabled call log again. */
export function _resetPlannerSyncLogForTests(): void {
  disabledLogged = false;
}
