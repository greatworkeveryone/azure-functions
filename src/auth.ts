import { HttpRequest, HttpResponseInit } from "@azure/functions";
import { TYPES } from "tedious";
import { closeConnection, createServiceConnection, executeQuery } from "./db";
import { isDevOverrideEnabled, verifyEntraToken } from "./jwt";
import { Sentry } from "./sentry";

// Audience claim Entra puts on tokens issued for Azure SQL. Used by
// rolesForRequest to verify the SQL bearer token before trusting its `oid`.
// Entra emits this with and without a trailing slash depending on token
// version / scope variant, so we accept both.
const SQL_AUDIENCE = [
  "https://database.windows.net/",
  "https://database.windows.net",
];

export enum AppRole {
  ACCOUNTS            = "accounts",
  ACCOUNTS_APPROVAL   = "accounts_manager",
  ADMIN               = "admin",
  DIRECTOR            = "director",
  FACILITIES          = "facilities",
  FACILITIES_APPROVAL = "facilities_manager",
  USER                = "user",
}

export function extractToken(request: HttpRequest): string | null {
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  return authHeader.replace("Bearer ", "").trim() || null;
}

export function unauthorizedResponse(): HttpResponseInit {
  return {
    status: 401,
    jsonBody: { error: "No authorization token provided" },
  };
}

export function forbiddenResponse(detail?: string): HttpResponseInit {
  return {
    status: 403,
    jsonBody: {
      error: "Forbidden — this action requires additional permissions.",
      details: detail,
    },
  };
}

// Second arg accepts either a raw Error/unknown (preferred — preserves the
// stack for Sentry) or a string (legacy). Either way we capture to Sentry so
// no 500 escapes silently.
export function errorResponse(message: string, errorOrDetails?: unknown): HttpResponseInit {
  const isDev = process.env.DEV_ROLE_OVERRIDE_ENABLED === "true";

  if (errorOrDetails instanceof Error) {
    Sentry.captureException(errorOrDetails, { extra: { context: message } });
  } else if (errorOrDetails !== undefined) {
    Sentry.captureException(new Error(message), {
      extra: { details: String(errorOrDetails) },
    });
  } else {
    Sentry.captureException(new Error(message));
  }

  const details =
    errorOrDetails instanceof Error
      ? errorOrDetails.message
      : errorOrDetails === undefined
        ? undefined
        : String(errorOrDetails);

  return {
    status: 500,
    jsonBody: isDev && details ? { error: message, details } : { error: message },
  };
}

// ── Identity extraction ──────────────────────────────────────────────────────
// Decodes the JWT payload without signature verification. This is safe here
// because the same token is passed to Azure SQL, which performs full Entra
// signature verification end-to-end — a forged token is rejected by SQL before
// it can do anything. We only use the decoded payload for the `oid` claim (user
// identity), never for authorization decisions directly.

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload.padEnd(
      payload.length + ((4 - (payload.length % 4)) % 4),
      "=",
    );
    const json = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function oidFromToken(token: string): string | null {
  const payload = decodeJwtPayload(token);
  const oid = payload?.oid;
  return typeof oid === "string" ? oid : null;
}

export function userInfoFromToken(token: string): { name: string; email: string } | null {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  const name = typeof payload.name === "string" ? payload.name : null;
  const email =
    typeof payload.preferred_username === "string"
      ? payload.preferred_username
      : typeof payload.upn === "string"
        ? payload.upn
        : null;
  if (!name || !email) return null;
  return { name, email };
}

// Display name only. Unlike userInfoFromToken this doesn't require an email
// claim — used for attribution columns where the name alone is enough. Carries
// the same "unverified decode" caveat as oidFromToken above.
export function nameFromToken(token: string): string | null {
  const payload = decodeJwtPayload(token);
  const name = payload?.name;
  return typeof name === "string" ? name : null;
}

/**
 * Reads the caller's app roles from the X-App-Token header.
 *
 * The app token is an Entra ID token whose audience is this app's clientId
 * (acquired with scope `${clientId}/.default`), so it carries the `roles`
 * claim directly — no Graph call needed.
 *
 * We verify the app token's signature against the tenant's JWKS, then
 * cross-check the OID in both tokens to ensure the app token belongs to the
 * same user as the SQL token. Without verification a forged X-App-Token
 * could claim any role.
 */
export async function rolesFromAppToken(
  sqlToken: string,
  appToken: string,
): Promise<string[]> {
  const expectedAudience = process.env.APP_CLIENT_ID ?? "";
  if (!expectedAudience) return [];

  const appPayload = await verifyEntraToken(appToken, expectedAudience);
  if (!appPayload) return [];

  // The SQL token is only used to cross-check OID — we verify it separately
  // (with its own audience) in rolesForRequest. Decoding the payload here
  // without verification is fine because the OID match is a defensive check,
  // not the trust anchor. The trust anchor is the verified app token above.
  const sqlPayload = decodeJwtPayload(sqlToken);
  if (!sqlPayload) return [];
  if (sqlPayload.oid !== appPayload.oid) return [];

  const roles = appPayload.roles;
  if (!Array.isArray(roles)) return [];
  return roles
    .filter((r): r is string => typeof r === "string")
    .map((r) => r.toLowerCase());
}

export async function rolesForRequest(request: HttpRequest): Promise<string[]> {
  // Gate the X-Dev-Roles bypass on the same two conditions jwt.ts uses for
  // signature-skipping — DEV_ROLE_OVERRIDE_ENABLED *and* a non-Production
  // host. Sharing isDevOverrideEnabled() keeps the two from drifting apart;
  // previously this checked only the env flag, so a deployment not labelled
  // Production could have honoured spoofed roles from the header.
  if (isDevOverrideEnabled()) {
    const header = request.headers.get("x-dev-roles");
    if (header) {
      const roles = header
        .split(",")
        .map((r) => r.trim().toLowerCase())
        .filter(Boolean);
      if (roles.length > 0) {
        console.warn(
          `[auth] DEV ROLE OVERRIDE active — using roles [${roles.join(", ")}] from X-Dev-Roles header`,
        );
        return roles;
      }
    }
  }

  const sqlToken = extractToken(request);
  if (!sqlToken) return [];

  // Verify signature, expiry, issuer and audience against the tenant's JWKS
  // before trusting the `oid` claim. SQL would reject a forged token at the
  // DB layer, but here we look the user up via a service connection — SQL
  // never sees this token, so we must verify it ourselves.
  const payload = await verifyEntraToken(sqlToken, SQL_AUDIENCE);
  if (!payload) return [];
  const oid = typeof payload.oid === "string" ? payload.oid : null;
  if (!oid) return [];

  const connection = await createServiceConnection();
  try {
    const rows = await executeQuery(
      connection,
      `SELECT Role FROM dbo.AppUsers WHERE EntraOid = @Oid AND IsActive = 1`,
      [{ name: "Oid", type: TYPES.NVarChar, value: oid }],
    );
    const role = rows[0]?.Role as string | null | undefined;
    return role ? [role.toLowerCase()] : [];
  } catch {
    return [];
  } finally {
    closeConnection(connection);
  }
}

/**
 * Verifies the caller's SQL bearer token and returns their identity from the
 * verified payload (`oid`, display name, email).
 *
 * Use this for write paths that establish identity but talk to the DB via a
 * *service* connection — e.g. registerSelf, which stamps an `EntraOid` onto a
 * pre-invited row. In those paths Azure SQL never validates the user's token
 * for us, so decoding it unverified (oidFromToken/userInfoFromToken) would let
 * a forged token claim someone else's row. Verifying the signature here is the
 * only thing preventing that privilege escalation.
 *
 * Returns null if the token is missing, fails verification, or lacks the
 * claims we need — callers should treat null as "reject" (401).
 */
export async function verifiedIdentityFromRequest(
  request: HttpRequest,
): Promise<{ oid: string; name: string; email: string } | null> {
  const token = extractToken(request);
  if (!token) return null;

  const payload = await verifyEntraToken(token, SQL_AUDIENCE);
  if (!payload || typeof payload.oid !== "string") return null;

  const name = typeof payload.name === "string" ? payload.name : null;
  const email =
    typeof payload.preferred_username === "string"
      ? payload.preferred_username
      : typeof payload.upn === "string"
        ? payload.upn
        : null;
  if (!name || !email) return null;

  return { oid: payload.oid, name, email };
}

/**
 * Returns null if the caller has at least one of the required roles,
 * or a 403 HttpResponseInit otherwise. Callers should early-return on the
 * non-null result.
 *
 * Role hierarchy applied here so call sites don't have to enumerate every
 * superset role:
 *   - `admin` satisfies every check.
 *   - `director` satisfies every non-admin-only check (anything operational).
 *   - `facilities_manager` satisfies any `facilities` check.
 *   - `accounts_manager`   satisfies any `accounts` check.
 */
export async function requireRole(
  request: HttpRequest,
  allowed: readonly AppRole[],
): Promise<HttpResponseInit | null> {
  const roles = await rolesForRequest(request);

  if (roles.includes(AppRole.ADMIN)) return null;

  if (
    roles.includes(AppRole.DIRECTOR) &&
    allowed.some((r) => r !== AppRole.ADMIN)
  ) return null;

  if (
    roles.includes(AppRole.FACILITIES_APPROVAL) &&
    allowed.includes(AppRole.FACILITIES)
  ) return null;

  if (
    roles.includes(AppRole.ACCOUNTS_APPROVAL) &&
    allowed.includes(AppRole.ACCOUNTS)
  ) return null;

  if (roles.some((r) => allowed.includes(r as AppRole))) return null;

  return forbiddenResponse(
    `Required role: ${allowed.join(" | ")}. Have: ${roles.join(", ") || "(none)"}`,
  );
}
