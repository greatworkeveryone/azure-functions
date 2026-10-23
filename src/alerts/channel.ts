// Real-time alert routes (D21). An urgent escalation tries each enabled channel for
// a person and falls back to the email pointer when none delivers. Teams is the first
// channel; a bot or web push would be another AlertChannel and nothing else changes.
// An alert is a pointer into Floorplan: no amounts, names or addresses in its text.

import { sendActivityNotification, type TeamsSendDeps } from "../teams/activity";
import { teamsAppId, teamsMode } from "../teams/config";
import type { EgressSubject } from "../test-data";

export type AlertChannelName = "teams";

export interface AlertTarget {
  /** AppUsers.EntraOid. */
  entraOid: string;
}

export interface Alert {
  /** What the alert is about; a test record's is refused (D9). */
  egress: EgressSubject;
  /** Shown on lock screens and toasts. */
  previewText: string;
  /** In-app path the alert opens. */
  route: string;
  text: string;
}

export type AlertStatus = "sent" | "dry_run" | "skipped" | "not_permitted" | "no_user" | "duplicate_app" | "retry" | "failed";

export interface AlertResult {
  detail: string | null;
  status: AlertStatus;
}

export interface AlertChannel {
  name: AlertChannelName;
  /** Never throws for a delivery problem; only "sent" means the person was told. */
  send(target: AlertTarget, alert: Alert): Promise<AlertResult>;
}

export function teamsChannel(deps: TeamsSendDeps = {}): AlertChannel {
  return {
    name: "teams",
    async send(target, alert): Promise<AlertResult> {
      const result = await sendActivityNotification(target.entraOid, alert, deps);
      return { detail: "error" in result ? result.error : null, status: result.status };
    },
  };
}

/** The channels switched on: Teams when its mode isn't off and TEAMS_APP_ID is set. */
export function resolveAlertChannels(env: NodeJS.ProcessEnv = process.env): AlertChannel[] {
  const channels: AlertChannel[] = [];
  if (teamsMode(env) !== "off" && teamsAppId(env) !== null) channels.push(teamsChannel({ env }));
  return channels;
}
