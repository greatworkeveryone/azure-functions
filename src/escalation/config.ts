// Environment the escalation engine reads, in one place.
//
//   APP_BASE_URL                 deep links in emails (https://floorplan.randazzo.properties)
//   GRAPH_SENDER_EMAIL           the mailbox escalation emails come from
//   GRAPH_TENANT_ID / _CLIENT_ID / _CLIENT_SECRET   Microsoft Graph credentials
//   DEV_EMAIL_OVERRIDE           every outgoing address becomes this one (dev, staging)
//   FACILITIES_MANAGER_EMAILS    fallback recipients, used only while no active
//                                facilities_manager exists
//   ESCALATION_HOLIDAYS          public holidays, YYYY-MM-DD, comma-separated
//   ESCALATION_THRESHOLD_DAYS_*  the stalled-job days per priority (plannerHelpers)
//   ESCALATION_SWEEP_ENABLED     "true" lets the sweep write; anything else and it does nothing
//   ESCALATION_SWEEP_DRY_RUN     "true" logs what the sweep would do and writes nothing
//   ESCALATION_SWEEP_MAX_ACTIONS most writes one run makes (default 100)

import { getFacilitiesManagerEmails } from "../plannerHelpers";
import { ROLES } from "./roles";

/** What must be set for an escalation email to go out. */
export const NOTIFICATION_ENV = [
  "APP_BASE_URL",
  "GRAPH_SENDER_EMAIL",
  "GRAPH_TENANT_ID",
  "GRAPH_CLIENT_ID",
  "GRAPH_CLIENT_SECRET",
] as const;

export function missingNotificationConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  return NOTIFICATION_ENV.filter((name) => !(env[name] ?? "").trim());
}

export function appBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const base = (env.APP_BASE_URL ?? "").trim().replace(/\/+$/, "");
  return base === "" ? null : base;
}

/** A path inside the app -> the full link, or null when APP_BASE_URL is unset. */
export function absoluteLink(path: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const base = appBaseUrl(env);
  return base === null ? null : `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

/** Env-list recipients per role: only the facilities managers have one. */
export function fallbackEmailsByRole(env: NodeJS.ProcessEnv = process.env): Record<string, string[]> {
  return { [ROLES.facilitiesManager]: getFacilitiesManagerEmails(env) };
}

export function sweepMode(env: NodeJS.ProcessEnv = process.env): "off" | "dry-run" | "live" {
  if (env.ESCALATION_SWEEP_DRY_RUN === "true") return "dry-run";
  return env.ESCALATION_SWEEP_ENABLED === "true" ? "live" : "off";
}

/** Sends tried per notification before the sweep stops retrying it and tells admin. */
export const MAX_NOTIFICATION_ATTEMPTS = 6;

export const DEFAULT_SWEEP_MAX_ACTIONS = 100;

export function sweepMaxActions(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number((env.ESCALATION_SWEEP_MAX_ACTIONS ?? "").trim());
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_SWEEP_MAX_ACTIONS;
}
