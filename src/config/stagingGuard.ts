// Staging is a test copy of production's data. It must never reach real email, MYOB, Teams or
// myBuildings, whatever the app settings say, so each outbound path asks here, at call time.
// Staging is AZURE_FUNCTIONS_ENVIRONMENT "Staging" (the System page reports the same word) or an app
// named *-staging, so renaming or losing the one setting cannot put staging back on real email.
// Production and unset behave as before.

import { randomUUID } from "crypto";

type Env = Record<string, string | undefined>;

export function isStaging(env: Env = process.env): boolean {
  return env.AZURE_FUNCTIONS_ENVIRONMENT?.trim().toLowerCase() === "staging" || /-staging$/i.test(env.WEBSITE_SITE_NAME?.trim() ?? "");
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
