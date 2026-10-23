// What Teams alerts read from the environment (WP63). Dark until switched on.
//
//   TEAMS_APP_ID           the Floorplan Teams app's id (manifest "id"), for tab deep links
//   TEAMS_ALERTS_ENABLED   "true" lets alerts go out; anything else and nothing is sent
//   TEAMS_ALERTS_DRY_RUN   "true" logs what would be sent and sends nothing
//                          (wins over TEAMS_ALERTS_ENABLED)
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
