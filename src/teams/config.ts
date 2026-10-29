// What Teams alerts read from the environment (WP63). Dark until switched on.
//
//   TEAMS_APP_ID           the Floorplan Teams app's id (manifest "id"), for tab deep links
//   TEAMS_ALERTS_ENABLED   "true" lets alerts go out; anything else and nothing is sent
//   TEAMS_ALERTS_DRY_RUN   "true" logs what would be sent and sends nothing
//                          (wins over TEAMS_ALERTS_ENABLED)
//   These two are the ONE mode switch for both routes below (no separate workflows pair).
//   TEAMS_ALERTS_ROUTE     "workflows" (default, stage 1) or "app" (stage 2, needs TEAMS_APP_ID)
//   TEAMS_WORKFLOW_WEBHOOK_URL  the Power Automate flow's HTTP URL (Key Vault reference; a secret,
//                          never logged)
//   TEAMS_WORKFLOW_KEY     sent as x-floorplan-key (Key Vault reference; never logged)
//
// Graph credentials are the mail ones: GRAPH_TENANT_ID / _CLIENT_ID / _CLIENT_SECRET.

export type TeamsMode = "dry-run" | "live" | "off";

export function teamsMode(env: NodeJS.ProcessEnv = process.env): TeamsMode {
  if (env.TEAMS_ALERTS_DRY_RUN === "true") return "dry-run";
  return env.TEAMS_ALERTS_ENABLED === "true" ? "live" : "off";
}

/** TEAMS_APP_ID, trimmed, or null when unset. */
export function teamsAppId(env: NodeJS.ProcessEnv = process.env): string | null {
  const id = (env.TEAMS_APP_ID ?? "").trim();
  return id === "" ? null : id;
}

export type TeamsAlertsRoute = "app" | "workflows";

/** TEAMS_ALERTS_ROUTE: "app" selects the Teams app, anything else is the Workflows flow. */
export function teamsAlertsRoute(env: NodeJS.ProcessEnv = process.env): TeamsAlertsRoute {
  return (env.TEAMS_ALERTS_ROUTE ?? "").trim().toLowerCase() === "app" ? "app" : "workflows";
}

export interface TeamsAlertsReadiness {
  mode: TeamsMode;
  /** Why alerts that are switched on can't go out (so they fall back to email); null when fine or off. */
  problem: string | null;
  route: TeamsAlertsRoute;
}

/** For /api/health: alerts switched on but missing what their route needs quietly become email only. */
export function teamsAlertsReadiness(env: NodeJS.ProcessEnv = process.env): TeamsAlertsReadiness {
  const mode = teamsMode(env);
  const route = teamsAlertsRoute(env);
  let problem: string | null = null;
  if (mode !== "off" && route === "app" && teamsAppId(env) === null) problem = "TEAMS_APP_ID is unset";
  if (mode === "live" && route === "workflows" && workflowConfig(env) === null) {
    problem = "TEAMS_WORKFLOW_WEBHOOK_URL or TEAMS_WORKFLOW_KEY is unset";
  }
  return { mode, problem, route };
}

/** The Workflows flow's URL and key, trimmed, or null when either is unset. */
export function workflowConfig(env: NodeJS.ProcessEnv = process.env): { key: string; url: string } | null {
  const url = (env.TEAMS_WORKFLOW_WEBHOOK_URL ?? "").trim();
  const key = (env.TEAMS_WORKFLOW_KEY ?? "").trim();
  return url === "" || key === "" ? null : { key, url };
}
