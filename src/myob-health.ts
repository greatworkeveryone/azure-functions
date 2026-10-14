// system.health escalations about MYOB (to admin, per the policy's ladder):
// every link or re-link, and every request refused for reaching into a centre
// the agreement keeps Floorplan out of. Best-effort: the refusal or link it
// reports has already happened, so a failure here is logged and sent to Sentry
// but never changes the outcome. The escalation engine is loaded lazily to
// keep it off the MYOB client's cold-start path.

import type { Connection } from "tedious";
import { closeConnection, createServiceRequestConnection } from "./db";
import { Sentry } from "./sentry";

export const MYOB_HEALTH_SUBJECTS = {
  agreement: "myob_agreement",
  link: "myob_link",
} as const;

export type MyobHealthSubject = (typeof MYOB_HEALTH_SUBJECTS)[keyof typeof MYOB_HEALTH_SUBJECTS];

export async function raiseMyobHealth(
  subjectId: MyobHealthSubject,
  summary: string,
  context: Record<string, unknown>,
): Promise<void> {
  let connection: Connection | undefined;
  try {
    connection = await createServiceRequestConnection();
    const { raise } = await import("./escalation");
    await raise(connection, {
      actor: { kind: "system", name: "myob" },
      context,
      notify: { attempts: 1 },
      policyKey: "system.health",
      skipConditionCheck: true,
      subjectId,
      subjectType: "system",
      summary: summary.slice(0, 400),
    });
  } catch (error) {
    console.error(`[myob-health] could not raise system.health (${subjectId}):`, error instanceof Error ? error.message : error);
    Sentry.captureException(error, { extra: { subjectId, summary }, tags: { area: "myob-health" } });
  } finally {
    if (connection) closeConnection(connection);
  }
}
