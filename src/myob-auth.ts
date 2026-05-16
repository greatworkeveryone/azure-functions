// MYOB AccountRight OAuth 2.0 helpers.
//
// Flow:
//   1. /myobAuthStart  → generate state, return MYOB authorize URL
//   2. User signs in to MYOB, MYOB 302s back to /myobAuthCallback?code=...&state=...
//   3. /myobAuthCallback → verify state, exchange code for tokens, store in DB
//   4. Other code calls getValidMyobAccessToken() — refreshes if expired
//
// State CSRF protection: we sign a (timestamp, nonce) tuple with MYOB_CLIENT_SECRET
// so the callback can verify the state was minted by us within the last 10
// minutes without keeping any server-side session.
//
// Required env vars:
//   MYOB_CLIENT_ID     — "Key" from the MYOB developer portal
//   MYOB_CLIENT_SECRET — "Secret" from the MYOB developer portal
//   MYOB_REDIRECT_URI  — must match the Redirect URI registered on the MYOB app

import { createHmac, randomBytes } from "crypto";
import { Connection } from "tedious";
import { TYPES } from "tedious";
import {
  closeConnection,
  createConnection,
  createServiceConnection,
  executeQuery,
} from "./db";

// Token storage reads/writes use the signed-in user's SQL connection when a
// token is available (every admin request has one). The OAuth callback runs
// without a user token — MYOB drives that redirect — so it falls back to the
// service-principal connection. The service principal must be a SQL user in
// prod; locally that path is only exercised during the actual auth dance.
async function openDbConnection(sqlToken: string | null): Promise<Connection> {
  return sqlToken ? createConnection(sqlToken) : createServiceConnection();
}

const MYOB_AUTHORIZE_URL = "https://secure.myob.com/oauth2/account/authorize/";
const MYOB_TOKEN_URL = "https://secure.myob.com/oauth2/v1/authorize/";
const STATE_TTL_MS = 10 * 60 * 1000;
const REFRESH_SKEW_MS = 60 * 1000; // refresh if access token expires in <60s

// ── Types ────────────────────────────────────────────────────────────────────

interface MyobTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  user?: { uid: string; username: string };
}

export interface MyobAuthStatus {
  linked: boolean;
  expiresAt: string | null;
  authorizedBy: string | null;
  authorizedAt: string | null;
  isExpired: boolean;
  scope: string | null;
}

export class MyobNotLinkedError extends Error {
  constructor() {
    super("MYOB is not linked — visit the admin page to authorize.");
    this.name = "MyobNotLinkedError";
  }
}

// ── State (CSRF) ─────────────────────────────────────────────────────────────

function stateSecret(): string {
  const secret = process.env.MYOB_CLIENT_SECRET;
  if (!secret) throw new Error("MYOB_CLIENT_SECRET is not configured");
  return secret;
}

export function generateAuthState(): string {
  const timestamp = Date.now().toString();
  const nonce = randomBytes(16).toString("hex");
  const hmac = createHmac("sha256", stateSecret())
    .update(`${timestamp}.${nonce}`)
    .digest("hex")
    .slice(0, 32);
  return Buffer.from(`${timestamp}.${nonce}.${hmac}`).toString("base64url");
}

export function verifyAuthState(state: string): boolean {
  try {
    const decoded = Buffer.from(state, "base64url").toString("utf8");
    const [timestamp, nonce, hmac] = decoded.split(".");
    if (!timestamp || !nonce || !hmac) return false;

    const expected = createHmac("sha256", stateSecret())
      .update(`${timestamp}.${nonce}`)
      .digest("hex")
      .slice(0, 32);
    if (expected !== hmac) return false;

    const age = Date.now() - Number(timestamp);
    return age >= 0 && age <= STATE_TTL_MS;
  } catch {
    return false;
  }
}

// ── Authorize URL ────────────────────────────────────────────────────────────

export function buildAuthorizeUrl(state: string): string {
  const clientId = process.env.MYOB_CLIENT_ID;
  const redirectUri = process.env.MYOB_REDIRECT_URI;
  if (!clientId) throw new Error("MYOB_CLIENT_ID is not configured");
  if (!redirectUri) throw new Error("MYOB_REDIRECT_URI is not configured");

  // Empty string ("") means "omit the scope param" — some MYOB app
  // registrations reject any scope string and default to whatever was granted.
  const scope = process.env.MYOB_SCOPE ?? "sme-company-file sme-purchases sme-banking sme-contacts-supplier";
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
  });
  if (scope) params.set("scope", scope);
  return `${MYOB_AUTHORIZE_URL}?${params.toString()}`;
}

// ── Token exchange + refresh ─────────────────────────────────────────────────

async function postTokenRequest(
  body: URLSearchParams,
): Promise<MyobTokenResponse> {
  const response = await fetch(MYOB_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`MYOB token endpoint ${response.status}: ${text}`);
  }
  return (await response.json()) as MyobTokenResponse;
}

export async function exchangeCodeForTokens(opts: {
  code: string;
  authorizedBy: string | null;
  sqlToken: string | null;
}): Promise<MyobAuthStatus> {
  const clientId = process.env.MYOB_CLIENT_ID;
  const clientSecret = process.env.MYOB_CLIENT_SECRET;
  const redirectUri = process.env.MYOB_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "MYOB OAuth env vars missing (MYOB_CLIENT_ID / MYOB_CLIENT_SECRET / MYOB_REDIRECT_URI)",
    );
  }

  const scope = process.env.MYOB_SCOPE ?? "sme-company-file sme-purchases sme-banking sme-contacts-supplier";
  const tokenBody = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code: opts.code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  if (scope) tokenBody.set("scope", scope);
  const tokens = await postTokenRequest(tokenBody);

  await persistTokens(tokens, opts.authorizedBy, opts.sqlToken);
  return getMyobAuthStatus(opts.sqlToken);
}

async function refreshTokens(refreshToken: string): Promise<MyobTokenResponse> {
  const clientId = process.env.MYOB_CLIENT_ID;
  const clientSecret = process.env.MYOB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("MYOB_CLIENT_ID / MYOB_CLIENT_SECRET not configured");
  }
  return postTokenRequest(
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  );
}

// ── DB persistence ───────────────────────────────────────────────────────────

async function persistTokens(
  tokens: MyobTokenResponse,
  authorizedBy: string | null,
  sqlToken: string | null,
): Promise<void> {
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  const connection = await openDbConnection(sqlToken);
  try {
    await executeQuery(
      connection,
      `MERGE dbo.MyobAuth AS target
       USING (SELECT 1 AS Id) AS src ON target.Id = src.Id
       WHEN MATCHED THEN UPDATE SET
         AccessToken  = @AccessToken,
         RefreshToken = @RefreshToken,
         ExpiresAt    = @ExpiresAt,
         Scope        = @Scope,
         AuthorizedBy = COALESCE(@AuthorizedBy, AuthorizedBy),
         AuthorizedAt = CASE WHEN @AuthorizedBy IS NOT NULL THEN SYSUTCDATETIME() ELSE AuthorizedAt END,
         UpdatedAt    = SYSUTCDATETIME()
       WHEN NOT MATCHED THEN INSERT
         (Id, AccessToken, RefreshToken, ExpiresAt, Scope, AuthorizedBy, AuthorizedAt, UpdatedAt)
         VALUES (1, @AccessToken, @RefreshToken, @ExpiresAt, @Scope, @AuthorizedBy, SYSUTCDATETIME(), SYSUTCDATETIME());`,
      [
        { name: "AccessToken", type: TYPES.NVarChar, value: tokens.access_token },
        { name: "RefreshToken", type: TYPES.NVarChar, value: tokens.refresh_token },
        { name: "ExpiresAt", type: TYPES.DateTime2, value: expiresAt },
        { name: "Scope", type: TYPES.NVarChar, value: tokens.scope ?? null },
        { name: "AuthorizedBy", type: TYPES.NVarChar, value: authorizedBy },
      ],
    );
  } finally {
    closeConnection(connection);
  }
}

interface MyobAuthRow {
  AccessToken: string;
  RefreshToken: string;
  ExpiresAt: Date;
  Scope: string | null;
  AuthorizedBy: string | null;
  AuthorizedAt: Date;
}

async function loadRow(sqlToken: string | null): Promise<MyobAuthRow | null> {
  const connection = await openDbConnection(sqlToken);
  try {
    const rows = await executeQuery(
      connection,
      `SELECT AccessToken, RefreshToken, ExpiresAt, Scope, AuthorizedBy, AuthorizedAt
       FROM dbo.MyobAuth WHERE Id = 1`,
    );
    if (rows.length === 0) return null;
    return rows[0] as unknown as MyobAuthRow;
  } finally {
    closeConnection(connection);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function getMyobAuthStatus(
  sqlToken: string | null,
): Promise<MyobAuthStatus> {
  const row = await loadRow(sqlToken);
  if (!row) {
    return {
      linked: false,
      expiresAt: null,
      authorizedBy: null,
      authorizedAt: null,
      isExpired: false,
      scope: null,
    };
  }
  const isExpired = row.ExpiresAt.getTime() <= Date.now();
  return {
    linked: true,
    expiresAt: row.ExpiresAt.toISOString(),
    authorizedBy: row.AuthorizedBy,
    authorizedAt: row.AuthorizedAt.toISOString(),
    isExpired,
    scope: row.Scope,
  };
}

/**
 * Returns a valid access token, refreshing if the stored token is within
 * REFRESH_SKEW_MS of expiry. Throws MyobNotLinkedError if no row exists.
 *
 * Pass the caller's SQL token so the DB read/write hits the user connection;
 * pass null only from background paths (timers, webhooks) where no user is
 * present and the service principal has SQL access.
 */
export async function getValidMyobAccessToken(
  sqlToken: string | null,
): Promise<string> {
  const row = await loadRow(sqlToken);
  if (!row) throw new MyobNotLinkedError();

  if (row.ExpiresAt.getTime() > Date.now() + REFRESH_SKEW_MS) {
    return row.AccessToken;
  }

  const refreshed = await refreshTokens(row.RefreshToken);
  await persistTokens(refreshed, null, sqlToken);
  return refreshed.access_token;
}
