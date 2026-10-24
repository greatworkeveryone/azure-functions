// The usage analytics switches (PLAN §14, UA1). Collection is opt-in because it records
// what people do, and the purge is opt-in because it deletes in bulk (database-safety
// rule 2): a value counts only when it is exactly "true".
//
//   USAGE_TRACKING_ENABLED=true   the ingest route stores batches and the roll-up timer runs;
//                                 otherwise the browser is told "off" and sends nothing
//   USAGE_RETENTION_DAYS          days raw rows are kept (default 180, never fewer than 30)
//   USAGE_PURGE_ENABLED=true      the purge timer deletes raw rows past retention, only for
//                                 days that are already rolled up
//   USAGE_PURGE_DRY_RUN=true      the purge timer counts and logs what it would delete (wins)

export type PurgeMode = "dry-run" | "live" | "off";

export const DEFAULT_RETENTION_DAYS = 180;
export const MIN_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 3650;

export function usageTrackingOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.USAGE_TRACKING_ENABLED === "true";
}

/** A value that is not a whole number from 30 to 3650 falls back to 180, so a typo cannot shorten what is kept. */
export function retentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const text = (env.USAGE_RETENTION_DAYS ?? "").trim();
  if (!/^\d{1,5}$/.test(text)) return DEFAULT_RETENTION_DAYS;
  const value = Number(text);
  return value >= MIN_RETENTION_DAYS && value <= MAX_RETENTION_DAYS ? value : DEFAULT_RETENTION_DAYS;
}

export function purgeMode(env: NodeJS.ProcessEnv = process.env): PurgeMode {
  if (env.USAGE_PURGE_DRY_RUN === "true") return "dry-run";
  return env.USAGE_PURGE_ENABLED === "true" ? "live" : "off";
}
