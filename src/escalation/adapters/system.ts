// The system adapter: escalations about Floorplan itself (policy system.health).
// The sweep raises one to admin when escalation emails cannot go out or a run
// fails, instead of skipping silently (LAUNCH-READINESS §4.2, "Unconfigured").
//
// The subject ids are fixed names:
//   notification_config   APP_BASE_URL / sender mailbox / Graph credentials missing
//   notifications         sends keep failing after every retry
//   sweep                 the last run failed or had failures (ended explicitly by
//                         the next clean run, so this adapter never auto-clears it)
//   money_gate            MONEY_ALLOWED_CIDRS is unset (the money-action gate only
//                         warns, S11) or has entries the gate cannot use; clears
//                         once it is set and every entry is usable

import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../../db";
import { moneyGateConfig } from "../../moneyGate";
import { MAX_NOTIFICATION_ATTEMPTS, missingNotificationConfig } from "../config";
import { normaliseRole, ROLES } from "../roles";
import type { EscalationAdapter } from "./registry";

export const SYSTEM_SUBJECTS = {
  moneyGate: "money_gate",
  notificationConfig: "notification_config",
  notifications: "notifications",
  sweep: "sweep",
} as const;

/** Sends that failed every retry (NotificationAttempts reached the cap). */
export async function countExhaustedNotifications(connection: Connection, maxAttempts: number): Promise<number> {
  const rows = await executeQuery(
    connection,
    `SELECT COUNT(*) AS Total FROM dbo.Escalations
     WHERE Status = 'open' AND NotificationState = 'failed' AND NotificationAttempts >= @MaxAttempts`,
    [{ name: "MaxAttempts", type: TYPES.Int, value: maxAttempts }],
  );
  return Number(rows[0]?.Total ?? 0);
}

const VIEWERS: ReadonlySet<string> = new Set([ROLES.admin, ROLES.director]);

export const systemAdapter: EscalationAdapter = {
  subjectType: "system",

  deepLink: () => "/escalations",

  async isConditionActive(connection, ref) {
    switch (ref.subjectId) {
      case SYSTEM_SUBJECTS.notificationConfig:
        return missingNotificationConfig().length > 0;
      case SYSTEM_SUBJECTS.notifications:
        return (await countExhaustedNotifications(connection, MAX_NOTIFICATION_ATTEMPTS)) > 0;
      case SYSTEM_SUBJECTS.moneyGate: {
        const gate = moneyGateConfig();
        return gate.mode === "warn" || gate.invalid.length > 0 || gate.entries === 0;
      }
      default:
        // sweep: the run that fixed it resolves it, not a condition check.
        return true;
    }
  },

  async loadSummary(_connection, subjectId) {
    const names: Record<string, string> = {
      [SYSTEM_SUBJECTS.moneyGate]: "The money-action gate needs attention: MONEY_ALLOWED_CIDRS is unset or has entries it cannot use",
      [SYSTEM_SUBJECTS.notificationConfig]: "Escalation emails can't be sent: notification settings are missing",
      [SYSTEM_SUBJECTS.notifications]: "Escalation emails keep failing to send",
      [SYSTEM_SUBJECTS.sweep]: "The escalation sweep had a problem",
    };
    const summary = names[subjectId];
    return summary ? { buildingId: null, context: { subject: subjectId }, summary } : null;
  },

  visibleTo: (viewer) => viewer.roles.some((role) => VIEWERS.has(normaliseRole(role))),
};
