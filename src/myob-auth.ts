// MYOB AccountRight OAuth 2.0.
//
// Flow:
//   1. /myobAuthStart   → an admin gets a single-use state bound to their oid
//                         (myob-auth-state.ts) and MYOB's authorize URL
//   2. MYOB 302s the browser to /myobAuthCallback?code&state&businessId
//   3. /myobAuthCallback → myob-link.ts: state consumed, businessId checked,
//                         code exchanged, scopes checked, tokens stored encrypted
//                         and the link ledgered
//   4. getValidMyobAccessToken() refreshes under sp_getapplock when near expiry
//
// Scopes are fixed in code (myob-endpoints.ts): `sme-company-file sme-purchases`.
// There is deliberately no environment override.
//
// Required env vars:
//   MYOB_CLIENT_ID     — "Key" from the MYOB developer portal
//   MYOB_CLIENT_SECRET — "Secret" from the MYOB developer portal
//   MYOB_REDIRECT_URI  — must match the Redirect URI registered on the MYOB app
//   MYOB_TOKEN_KEY     — see myob-token-crypto.ts

import type { Connection } from "tedious";
import {
  beginTransaction,
  closeConnection,
  commitTransaction,
  createRequestConnection,
  createServiceRequestConnection,
  rollbackTransaction,
} from "./db";
import { myobRequest, type MyobActor } from "./myob-api-log";
import {
  lockMyobTokens,
  openStoredTokens,
  readMyobAuthRow,
  saveRefreshedTokens,
  type MyobTokenResponse,
} from "./myob-auth-store";
import { MYOB_SCOPE_STRING, MYOB_SCOPES, MYOB_TOKEN_URL } from "./myob-endpoints";

export { MyobRelinkRequiredError } from "./myob-auth-store";
export type { MyobTokenResponse } from "./myob-auth-store";
export { getMyobAuthStatus, type MyobAuthStatus } from "./myob-auth-status";

const MYOB_AUTHORIZE_URL = "https://secure.myob.com/oauth2/account/authorize/";
const REFRESH_SKEW_MS = 60 * 1000; // refresh if access token expires in <60s

async function openDbConnection(sqlToken: string | null): Promise<Connection> {
  return sqlToken ? createRequestConnection(sqlToken) : createServiceRequestConnection();
}

export class MyobNotLinkedError extends Error {
  constructor() {
    super("MYOB is not linked — visit the admin page to authorize.");
    this.name = "MyobNotLinkedError";
  }
}

export class MyobScopeError extends Error {
  constructor(extra: string[]) {
    super(`MYOB granted access Floorplan did not ask for (${extra.join(", ")}); nothing was stored`);
    this.name = "MyobScopeError";
  }
}

// ── Authorize URL and scopes ─────────────────────────────────────────────────

export function buildAuthorizeUrl(state: string): string {
  const clientId = process.env.MYOB_CLIENT_ID;
  const redirectUri = process.env.MYOB_REDIRECT_URI;
  if (!clientId) throw new Error("MYOB_CLIENT_ID is not configured");
  if (!redirectUri) throw new Error("MYOB_REDIRECT_URI is not configured");
  const params = new URLSearchParams({
    client_id: clientId,
    prompt: "consent",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: MYOB_SCOPE_STRING,
    state,
  });
  return `${MYOB_AUTHORIZE_URL}?${params.toString()}`;
}

/** Refuses a token that carries any scope beyond the two the agreement allows. */
export function assertGrantedScope(scope: string | undefined): void {
  const allowed = new Set<string>(MYOB_SCOPES);
  const extra = (scope ?? "").split(/[\s,]+/).filter((s) => s && !allowed.has(s));
  if (extra.length) throw new MyobScopeError(extra);
}

// ── Token endpoint ───────────────────────────────────────────────────────────

function clientCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.MYOB_CLIENT_ID;
  const clientSecret = process.env.MYOB_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("MYOB_CLIENT_ID / MYOB_CLIENT_SECRET not configured");
  return { clientId, clientSecret };
}

// Through myobRequest like every other MYOB call, so token exchanges and
// refreshes are in the audit log too (the log redacts the secrets in them).
async function postTokenRequest(body: URLSearchParams, actor: MyobActor, purpose: string, correlationId?: string) {
  const response = await myobRequest({
    actor,
    body,
    correlationId,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
    purpose,
    url: MYOB_TOKEN_URL,
  });
  if (!response.ok) throw new Error(`MYOB token endpoint ${response.status}: ${response.text}`);
  return response.json<MyobTokenResponse>();
}

/** Exchanges an authorization code. Stores nothing: myob-link.ts decides whether to keep the tokens. */
export async function exchangeCode(code: string, actor: MyobActor, correlationId?: string): Promise<MyobTokenResponse> {
  const { clientId, clientSecret } = clientCredentials();
  const redirectUri = process.env.MYOB_REDIRECT_URI;
  if (!redirectUri) throw new Error("MYOB_REDIRECT_URI is not configured");
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    scope: MYOB_SCOPE_STRING,
  });
  const tokens = await postTokenRequest(body, actor, "oauth-token-exchange", correlationId);
  assertGrantedScope(tokens.scope);
  return tokens;
}

async function refreshTokens(refreshToken: string, actor: MyobActor, correlationId?: string): Promise<MyobTokenResponse> {
  const { clientId, clientSecret } = clientCredentials();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const tokens = await postTokenRequest(body, actor, "oauth-token-refresh", correlationId);
  assertGrantedScope(tokens.scope);
  return tokens;
}

// ── Access ──────────────────────────────────────────────────────────────────

/**
 * Returns a valid access token, refreshing it when it expires within
 * REFRESH_SKEW_MS. The refresh runs in a transaction holding
 * sp_getapplock('myob_refresh') and re-reads the row under the lock, so
 * concurrent callers refresh once and the rest use the new token.
 */
export async function getValidMyobAccessToken(
  sqlToken: string | null,
  actor: MyobActor,
  correlationId?: string,
): Promise<string> {
  const connection = await openDbConnection(sqlToken);
  try {
    const row = await readMyobAuthRow(connection);
    if (!row) throw new MyobNotLinkedError();
    const tokens = openStoredTokens(row);
    if (row.ExpiresAt.getTime() > Date.now() + REFRESH_SKEW_MS) return tokens.accessToken;

    await beginTransaction(connection);
    try {
      await lockMyobTokens(connection);
      const locked = await readMyobAuthRow(connection);
      if (!locked) throw new MyobNotLinkedError();
      const current = openStoredTokens(locked);
      if (locked.ExpiresAt.getTime() > Date.now() + REFRESH_SKEW_MS) {
        await commitTransaction(connection);
        return current.accessToken;
      }
      const refreshed = await refreshTokens(current.refreshToken, actor, correlationId);
      await saveRefreshedTokens(connection, refreshed);
      await commitTransaction(connection);
      return refreshed.access_token;
    } catch (error) {
      await rollbackTransaction(connection).catch(() => undefined);
      throw error;
    }
  } finally {
    closeConnection(connection);
  }
}
