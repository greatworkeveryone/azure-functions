// Staging is a test copy of production's data. It must never reach real email, MYOB, Teams, myBuildings,
// Planner or the public website, whatever the app settings say, so each outbound path asks here, at call time.
//
// It fails safe (REV-06): the guard is off only where the environment is stated as exactly "Production",
// or on a developer's machine (no WEBSITE_INSTANCE_ID, which Azure sets on every deployed Function App).
// "Staging", any other value, a misspelling, or no value at all on a deployed app means guarded.
// Production must therefore have AZURE_FUNCTIONS_ENVIRONMENT=Production set.

import { randomUUID } from "crypto";

type Env = Record<string, string | undefined>;

export function isStaging(env: Env = process.env): boolean {
  const environment = env.AZURE_FUNCTIONS_ENVIRONMENT;
  if (environment === "Staging") return true;
  const deployed = typeof env.WEBSITE_INSTANCE_ID === "string" && env.WEBSITE_INSTANCE_ID !== "";
  return deployed && environment !== "Production";
}

/** The id a skipped send reports, so a flow that stores it still walks through its states. */
export function syntheticStagingId(prefix = "staging-not-sent"): string {
  return `${prefix}-${randomUUID()}`;
}

/** What a skipped email logs: never an address or a body. */
export function logStagingEmailSkipped(): void {
  console.warn("staging: email not sent");
}

/** For a timer or webhook that would otherwise call out: true (after logging) when it must skip. */
export function skipOnStaging(log: (message: string) => void, what: string, env: Env = process.env): boolean {
  if (!isStaging(env)) return false;
  log(`staging: ${what} skipped`);
  return true;
}
