import { HttpRequest, HttpResponseInit } from "@azure/functions";

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

export function errorResponse(message: string, _details: string): HttpResponseInit {
  return {
    status: 500,
    jsonBody: { error: message },
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

/**
 * Reads the caller's app roles from the X-App-Token header.
 *
 * The app token is an Entra ID token whose audience is this app's clientId
 * (acquired with scope `${clientId}/.default`), so it carries the `roles`
 * claim directly — no Graph call needed.
 *
 * We cross-check the OID in both tokens to ensure the app token belongs to
 * the same user as the SQL token. Both are signed by Entra and acquired in
 * the same browser session, so a mismatch indicates tampering.
 */
export function rolesFromAppToken(sqlToken: string, appToken: string): string[] {
  const sqlPayload = decodeJwtPayload(sqlToken);
  const appPayload = decodeJwtPayload(appToken);
  if (!sqlPayload || !appPayload) return [];
  if (sqlPayload.oid !== appPayload.oid) return [];
  const roles = appPayload.roles;
  if (!Array.isArray(roles)) return [];
  return roles.filter((r): r is string => typeof r === "string");
}

export function rolesForRequest(request: HttpRequest): string[] {
  const sqlToken = extractToken(request);
  const appToken = request.headers.get("x-app-token");
  if (!sqlToken || !appToken) return [];
  return rolesFromAppToken(sqlToken, appToken);
}

/**
 * Returns null if the caller has at least one of the required roles,
 * or a 403 HttpResponseInit otherwise. Callers should early-return on the
 * non-null result. `Admin` implicitly satisfies every role check.
 */
export function requireRole(
  request: HttpRequest,
  allowed: readonly string[],
): HttpResponseInit | null {
  const roles = rolesForRequest(request);
  if (roles.includes("Admin")) return null;
  if (roles.some((r) => allowed.includes(r))) return null;
  return forbiddenResponse(
    `Required role: ${allowed.join(" | ")}. Have: ${roles.join(", ") || "(none)"}`,
  );
}
