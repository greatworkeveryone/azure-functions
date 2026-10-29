// Which token audiences the API accepts as a bearer (audit M7). "sql" is the
// legacy SQL-scoped token; "api" is a token minted for this app.

export type ApiAudienceMode = "sql" | "both" | "api";

type Env = Record<string, string | undefined>;

const MODES: readonly ApiAudienceMode[] = ["sql", "both", "api"];

// Entra emits the SQL audience with and without a trailing slash.
const SQL_AUDIENCES = ["https://database.windows.net/", "https://database.windows.net"];

function rawMode(env: Env): string {
  return (env.API_TOKEN_AUDIENCE ?? "").trim().toLowerCase();
}

/** Active mode; unset or unrecognised is "sql" (audienceConfigProblem reports the latter). */
export function apiAudienceMode(env: Env = process.env): ApiAudienceMode {
  const raw = rawMode(env);
  return MODES.find((m) => m === raw) ?? "sql";
}

function appAudiences(env: Env): string[] {
  const clientId = env.APP_CLIENT_ID?.trim();
  const override = env.API_TOKEN_AUDIENCE_URI?.trim();
  return [
    // v2.0 tokens carry the bare client id, v1.0 tokens the api:// URI.
    ...(clientId ? [clientId, `api://${clientId}`] : []),
    ...(override ? [override] : []),
  ];
}

/** Audiences verifyEntraToken accepts. With no app audience configured, falls back to SQL. */
export function acceptedAudiences(env: Env = process.env): string[] {
  const mode = apiAudienceMode(env);
  const app = appAudiences(env);
  if (mode === "sql" || app.length === 0) return [...SQL_AUDIENCES];
  return mode === "api" ? app : [...SQL_AUDIENCES, ...app];
}

/** A reason this configuration is unsafe or invalid, else null. */
export function audienceConfigProblem(env: Env = process.env): string | null {
  const raw = rawMode(env);
  if (raw && !MODES.some((m) => m === raw)) {
    return `API_TOKEN_AUDIENCE must be one of sql, both, api (got "${env.API_TOKEN_AUDIENCE}").`;
  }
  const mode = apiAudienceMode(env);
  if (mode !== "sql" && appAudiences(env).length === 0) {
    return `API_TOKEN_AUDIENCE=${mode} needs APP_CLIENT_ID (or API_TOKEN_AUDIENCE_URI).`;
  }
  if (mode === "api" && env.SQL_USER_CONNECTION === "true") {
    return "API_TOKEN_AUDIENCE=api cannot be combined with SQL_USER_CONNECTION=true: the rollback lever needs a SQL-scoped token.";
  }
  return null;
}
