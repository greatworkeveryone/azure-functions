// Which policy a person's manual escalation uses. A subject type with its own
// manual policy (job.manual) uses it; every other subject uses any.manual. The
// caller never picks the policy, so nobody can raise job.critical or
// system.health by hand.

import type { Connection } from "tedious";
import { EscalationError } from "./errors";
import { getPolicy } from "./policies";

export async function manualPolicyKey(connection: Connection, subjectType: string): Promise<string> {
  const own = `${subjectType}.manual`;
  if ((await getPolicy(connection, own))?.active) return own;
  const fallback = await getPolicy(connection, "any.manual");
  if (!fallback?.active) throw new EscalationError("policy_inactive", "Manual escalation is switched off");
  return "any.manual";
}
