// The settings that change behaviour without any screen saying so, read for deep
// health. Words and flags only: never a key, a secret, an address or a URL.

import { digestMode } from "../digest/config";
import { isStaging } from "../config/stagingGuard";
import { sweepMode, sweepSince } from "../escalation/config";
import { twoPersonGrantEnabled } from "../roleGrants";

export interface HealthSwitches {
  digest: "dry-run" | "live" | "off";
  environment: string;
  /** True when the staging guard is on: AZURE_FUNCTIONS_ENVIRONMENT is "Staging", or a deployed app that is not exactly "Production". Email, MYOB, Teams, myBuildings, Planner and website writes are refused. */
  stagingGuardActive: boolean;
  /** Nightly myBuildings read: on unless set to "false". */
  mybuildingsSync: boolean;
  /** Pushing contractor details to myBuildings: on unless set to "false" (and never on staging). */
  mybuildingsContractorPush: boolean;
  privilegedGrantTwoPerson: boolean;
  escalationSweep: { mode: "dry-run" | "live" | "off"; since: string | null };
}

export function healthSwitches(env: NodeJS.ProcessEnv = process.env): HealthSwitches {
  const since = sweepSince(env);
  return {
    digest: digestMode(env),
    environment: env.AZURE_FUNCTIONS_ENVIRONMENT ?? "unknown",
    escalationSweep: { mode: sweepMode(env), since: since ? (env.ESCALATION_SWEEP_SINCE ?? "").trim() : null },
    mybuildingsContractorPush: !isStaging(env) && env.MYBUILDINGS_CONTRACTOR_PUSH !== "false",
    mybuildingsSync: env.MYBUILDINGS_SYNC_ENABLED !== "false",
    privilegedGrantTwoPerson: twoPersonGrantEnabled(env),
    stagingGuardActive: isStaging(env),
  };
}
