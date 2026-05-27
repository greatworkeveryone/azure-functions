// ─────────────────────────────────────────────────────────────────────────────
// JWT verification helper for Entra ID tokens.
//
// Uses `jose` with a remote JWKS to verify token signatures, issuer, audience,
// and expiry. The JWKS is cached in-memory by `jose` for the lifetime of the
// Functions worker — the first request after a cold start pays the fetch cost,
// every subsequent request hits the cache.
//
// Production code path: full signature verification via JWKS.
// Local dev escape hatch: when DEV_ROLE_OVERRIDE_ENABLED=true AND the host is
// NOT running under AZURE_FUNCTIONS_ENVIRONMENT=Production, we skip
// verification and just decode the payload. This keeps offline / no-Entra
// development working and is gated tightly enough that it cannot enable in
// the deployed Function App.
// ─────────────────────────────────────────────────────────────────────────────

import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";
import type { JWTPayload, JWTVerifyGetKey } from "jose";

const ISSUER_V2 = (tenantId: string): string =>
  `https://login.microsoftonline.com/${tenantId}/v2.0`;
const ISSUER_V1 = (tenantId: string): string =>
  `https://sts.windows.net/${tenantId}/`;

// Lazily initialised — first call to `verifyEntraToken` constructs and caches
// the JWKS for the tenant. Storing by tenantId guards against env changes in
// long-running test workers.
const jwksCache = new Map<string, JWTVerifyGetKey>();

function getJwks(tenantId: string): JWTVerifyGetKey {
  const cached = jwksCache.get(tenantId);
  if (cached) return cached;
  const jwks = createRemoteJWKSet(
    new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`),
  );
  jwksCache.set(tenantId, jwks);
  return jwks;
}

function decodeWithoutVerify(token: string): JWTPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload.padEnd(
      payload.length + ((4 - (payload.length % 4)) % 4),
      "=",
    );
    const json = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(json) as JWTPayload;
  } catch {
    return null;
  }
}

function isDevOverrideEnabled(): boolean {
  return (
    process.env.DEV_ROLE_OVERRIDE_ENABLED === "true" &&
    process.env.AZURE_FUNCTIONS_ENVIRONMENT !== "Production"
  );
}

/**
 * Verifies an Entra ID JWT against the tenant's JWKS, checking signature,
 * expiry, issuer and audience. Returns the payload on success, null on any
 * verification failure (never throws — callers can treat null as "reject").
 *
 * `expectedAudience` is the resource the token was issued for:
 *   - Azure SQL tokens:   "https://database.windows.net/"
 *   - This app's tokens:  the app's clientId (process.env.APP_CLIENT_ID)
 *
 * Accepts both the v2.0 issuer (`/v2.0`) and the v1.0 issuer
 * (`sts.windows.net`) — Entra issues v1.0 issuer claims for some resource
 * audiences (notably Azure SQL).
 */
export async function verifyEntraToken(
  token: string,
  expectedAudience: string,
): Promise<JWTPayload | null> {
  if (isDevOverrideEnabled()) {
    return decodeWithoutVerify(token);
  }

  const tenantId = process.env.GRAPH_TENANT_ID;
  if (!tenantId) {
    return null;
  }
  if (!token) return null;

  const jwks = getJwks(tenantId);
  try {
    const { payload } = await jwtVerify(token, jwks, {
      audience: expectedAudience,
      issuer: [ISSUER_V2(tenantId), ISSUER_V1(tenantId)],
    });
    return payload;
  } catch (err) {
    // Swallow any verification error — invalid signature, expired token,
    // wrong issuer/audience, network blip to JWKS, etc. The caller treats a
    // null return as "reject the request".
    if (!(err instanceof joseErrors.JOSEError)) {
      // Unexpected (non-jose) error — log so we don't silently lose signal,
      // but still fail closed.
      console.error("[jwt] unexpected verification error", err);
    }
    return null;
  }
}
