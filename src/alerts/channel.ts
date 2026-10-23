// Real-time alert routes (D21). An urgent escalation tries each enabled channel for
// a person and falls back to the email pointer when none delivers. Teams is the first
// channel; a bot or web push would be another AlertChannel and nothing else changes.
// An alert is a pointer into Floorplan: no amounts, names or addresses in its text.

import type { Connection } from "tedious";
import { domainOf, orgEmailDomains } from "../email/sender-auth";
import { resolveRecipient } from "../email-recipient";
import { sendActivityNotification, type TeamsSendDeps } from "../teams/activity";
import { teamsAlertsRoute, teamsAppId, teamsMode, workflowConfig } from "../teams/config";
import { isSafeAppRoute } from "../teams/deepLink";
import { assertMayLeave, type EgressSubject } from "../test-data";
import { claimWorkflowsSlot } from "./rateCap";

export type AlertChannelName = "teams" | "workflows";

/**
 * What the Workflows flow shows, chosen from this fixed list (the flow mirrors it, so a leaked
 * URL can't send custom text). Fixed title "Floorplan", then one generic line:
 *   escalation  "An escalation needs you"
 *   decision    "A decision is waiting for you"
 *   reminder    "An urgent item is still waiting"
 * No names, amounts, addresses or titles: lock screens are public.
 */
export type AlertKind = "decision" | "escalation" | "reminder";

export interface AlertTarget {
  /** AppUsers.Email, for the Workflows route; null when none. */
  email: string | null;
  /** AppUsers.EntraOid, for the Teams app route; null until first sign-in. */
  entraOid: string | null;
}

export interface Alert {
  /** What the alert is about; a test record's is refused (D9). */
  egress: EgressSubject;
  /** Which generic line the Workflows flow shows. */
  kind: AlertKind;
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
  /** The address a target must have for this channel; without it the channel is skipped. */
  needs: "email" | "entraOid";
  /** Never throws for a delivery problem; only "sent" means the person was told. */
  send(target: AlertTarget, alert: Alert): Promise<AlertResult>;
}

export function teamsChannel(deps: TeamsSendDeps = {}): AlertChannel {
  return {
    name: "teams",
    needs: "entraOid",
    async send(target, alert): Promise<AlertResult> {
      if (target.entraOid === null) return { detail: "no Entra id", status: "no_user" };
      const result = await sendActivityNotification(target.entraOid, alert, deps);
      return { detail: "error" in result ? result.error : null, status: result.status };
    },
  };
}

export interface WorkflowsDeps {
  /** Takes a rate-cap slot; false = over the cap (or no log table), so email instead. */
  claimSlot: () => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  log?: (message: string) => void;
}

const WORKFLOWS_TIMEOUT_MS = 10_000;

/**
 * Stage 1: one POST to the Power Automate flow, which builds the card. Body is only
 * { recipient, route, kind }, never card JSON or text. The URL and key are secrets and are
 * never logged, nor is the response body. One attempt: a 5xx may have landed, so no retry.
 */
export function workflowsChannel(deps: WorkflowsDeps): AlertChannel {
  return {
    name: "workflows",
    needs: "email",
    async send(target, alert): Promise<AlertResult> {
      assertMayLeave("teams", alert.egress);
      const env = deps.env ?? process.env;
      const mode = teamsMode(env);
      if (mode === "off") return { detail: null, status: "skipped" };

      const address = resolveRecipient(target.email).address;
      if (address === null) return { detail: "no email address", status: "no_user" };
      const domain = domainOf(address);
      if (domain === null || !orgEmailDomains(env).includes(domain)) return { detail: "recipient outside the organisation", status: "failed" };
      if (!isSafeAppRoute(alert.route)) return { detail: "unsafe route", status: "failed" };

      if (mode === "dry-run") {
        (deps.log ?? ((message: string) => console.warn(message)))(`workflows dry-run: would alert ${address} (${alert.kind}) -> ${alert.route}`);
        return { detail: null, status: "dry_run" };
      }
      const config = workflowConfig(env);
      if (config === null) return { detail: "workflow URL or key not configured", status: "failed" };
      if (!(await deps.claimSlot())) return { detail: "rate cap reached", status: "skipped" };

      let resp: Response;
      try {
        resp = await (deps.fetch ?? fetch)(config.url, {
          body: JSON.stringify({ kind: alert.kind, recipient: address, route: alert.route }),
          headers: { "Content-Type": "application/json", "x-floorplan-key": config.key },
          method: "POST",
          signal: AbortSignal.timeout(WORKFLOWS_TIMEOUT_MS),
        });
      } catch (err) {
        // The error message can carry the URL, so only its name is kept.
        return { detail: `network error (${err instanceof Error ? err.name : "unknown"})`, status: "retry" };
      }
      const detail = `HTTP ${resp.status}`;
      // 202 = the flow accepted it, not proof Teams posted it (the flow's failure email covers that).
      if (resp.status === 202) return { detail: null, status: "sent" };
      if (resp.status === 401 || resp.status === 403 || resp.status === 404) return { detail, status: "not_permitted" };
      if (resp.status === 429 || resp.status >= 500) return { detail, status: "retry" };
      return { detail, status: "failed" };
    },
  };
}

export interface ResolveChannelsDeps {
  /** For the Workflows rate cap. */
  connection?: Connection;
  claimSlot?: () => Promise<boolean>;
}

/**
 * The channels switched on. Nothing while the mode is off. Otherwise TEAMS_ALERTS_ROUTE picks
 * one: "workflows" (default; needs the URL and key unless dry-run) or "app" (needs TEAMS_APP_ID).
 */
export function resolveAlertChannels(env: NodeJS.ProcessEnv = process.env, deps: ResolveChannelsDeps = {}): AlertChannel[] {
  const mode = teamsMode(env);
  if (mode === "off") return [];
  if (teamsAlertsRoute(env) === "app") return teamsAppId(env) === null ? [] : [teamsChannel({ env })];
  if (mode === "live" && workflowConfig(env) === null) return [];
  const { connection } = deps;
  const claimSlot = deps.claimSlot ?? (connection ? () => claimWorkflowsSlot(connection) : async () => false);
  return [workflowsChannel({ claimSlot, env })];
}
