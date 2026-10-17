// What the facilities scheduler is doing, from its app settings. Its own file so
// handlers that only report the mode (the Maintenance page's overview, a
// schedule's drawer) don't pull in the whole scheduler.

export type SchedulerMode = "off" | "dry-run" | "live";

export function schedulerMode(env: NodeJS.ProcessEnv = process.env): SchedulerMode {
  if (env.SCHEDULER_DRY_RUN === "true") return "dry-run";
  return env.SCHEDULER_ENABLED === "true" ? "live" : "off";
}
