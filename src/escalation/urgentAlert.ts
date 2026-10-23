// Urgent escalations get a real-time alert before any email (D21): per target with an
// Entra id, each enabled channel is tried once, and only a "sent" result replaces that
// person's email. Anything else (not installed, retry, dry run, no id) leaves the email
// to go as before. A channel is never retried here, so a 5xx that may have landed can't
// alert twice.

import type { AlertChannel, AlertResult } from "../alerts/channel";
import type { EgressSubject } from "../test-data";
import { normaliseRole, ROLES } from "./roles";
import type { DirectoryUser, EscalationRow } from "./types";

type AlertEvent = "raise" | "reminder" | "supersede";

/** Level 2 and up, a row raised urgent, or an authority decision for a director. */
export function isUrgentAlert(row: EscalationRow): boolean {
  return row.urgent || row.level >= 2 || (row.kind === "authority" && normaliseRole(row.targetRole) === ROLES.director);
}

export function isAlertEvent(event: string): event is AlertEvent {
  return event === "raise" || event === "reminder" || event === "supersede";
}

/** Generic on purpose: lock screens are public, so no amounts, names or addresses. */
export function alertCopy(event: AlertEvent): { previewText: string; text: string } {
  return event === "reminder"
    ? { previewText: "Floorplan: an urgent item is still waiting", text: "An urgent item in Floorplan is still waiting. Open it to see what is needed." }
    : { previewText: "Floorplan: urgent item needs you", text: "An urgent item in Floorplan needs your attention. Open it to see what is needed." };
}

export interface UrgentDelivery {
  /** The people a channel told; they get no email. */
  toldUserIds: Set<number>;
}

export async function deliverUrgentAlerts(
  targets: readonly DirectoryUser[],
  event: AlertEvent,
  route: string,
  egress: EgressSubject,
  channels: readonly AlertChannel[],
  log?: (message: string) => void,
): Promise<UrgentDelivery> {
  const toldUserIds = new Set<number>();
  const copy = alertCopy(event);
  for (const user of targets) {
    if (!user.entraOid) continue;
    for (const channel of channels) {
      let result: AlertResult;
      try {
        result = await channel.send({ entraOid: user.entraOid }, { egress, route, ...copy });
      } catch (error) {
        result = { detail: error instanceof Error ? error.message : String(error), status: "failed" };
      }
      if (result.status === "sent") {
        toldUserIds.add(user.userId);
        break;
      }
      log?.(`urgent alert via ${channel.name} not sent for user ${user.userId} (${result.status}); email will go`);
    }
  }
  return { toldUserIds };
}
