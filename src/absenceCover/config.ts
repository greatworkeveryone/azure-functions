// The cover engine's switches. Opt-in, because it moves work in bulk (database-safety
// rule 2): a value counts only when it is exactly "true". Mirrors the lease events
// generator: the dry run wins over ENABLED, and with neither the timer does nothing
// and does not touch the database.
//
//   ABSENCE_COVER_ENABLED=true       moves work to a cover, and lists the rest
//   ABSENCE_COVER_DRY_RUN=true       writes `suggested` rows only and moves nothing
//   ABSENCE_INACTIVITY_DAYS          business days with no sign-in that count as away (default 3)
//   ABSENCE_COVER_MAX_ACTIONS        most ledger rows one run writes, most urgent first (default 50)

export type CoverMode = "dry-run" | "live" | "off";

export const DEFAULT_INACTIVITY_DAYS = 3;
export const MAX_INACTIVITY_DAYS = 30;
export const DEFAULT_MAX_ACTIONS = 50;
/** A run where more than this share of active staff look absent from their sign-ins alone is not trusted (database-safety rule 2). */
export const MAX_INACTIVE_SHARE = 0.2;

export function coverMode(env: NodeJS.ProcessEnv = process.env): CoverMode {
  if (env.ABSENCE_COVER_DRY_RUN === "true") return "dry-run";
  return env.ABSENCE_COVER_ENABLED === "true" ? "live" : "off";
}

function wholeNumber(raw: string | undefined): number | null {
  const text = (raw ?? "").trim();
  if (!/^\d{1,6}$/.test(text)) return null;
  const value = Number(text);
  return value > 0 ? value : null;
}

/** A value that is not a whole number from 1 to 30 falls back to 3, so a typo cannot switch the rule off. */
export function inactivityDays(env: NodeJS.ProcessEnv = process.env): number {
  const value = wholeNumber(env.ABSENCE_INACTIVITY_DAYS);
  return value !== null && value <= MAX_INACTIVITY_DAYS ? value : DEFAULT_INACTIVITY_DAYS;
}

export function maxActions(env: NodeJS.ProcessEnv = process.env): number {
  return wholeNumber(env.ABSENCE_COVER_MAX_ACTIONS) ?? DEFAULT_MAX_ACTIONS;
}

/** Access logging is on unless ACCESS_LOG_ENABLED is "false" (the access log's own default). */
export function accessLoggingOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ACCESS_LOG_ENABLED !== "false";
}

/** Whether a holiday calendar is configured (ESCALATION_HOLIDAYS), for the line that says which is used. */
export function holidayCalendarConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.ESCALATION_HOLIDAYS ?? "").trim() !== "";
}
