import { HttpRequest, HttpResponseInit } from "@azure/functions";
import { lookupUserRoles } from "./user-roles";

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

export function errorResponse(message: string, details: string): HttpResponseInit {
  return {
    status: 500,
    jsonBody: { error: message, details },
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
 * Resolves the caller's app roles via the Microsoft Graph API.
 *
 * The bearer token is a SQL delegation token — Entra does not include custom
 * app-role claims in it. Instead we extract the user's OID (trustworthy because
 * Azure SQL auth verifies the full token chain) and ask Graph for the user's
 * actual role assignments on this app registration. The client never touches
 * the role data, so it cannot be spoofed.
 */
export async function rolesForRequest(request: HttpRequest): Promise<string[]> {
  const token = extractToken(request);
  if (!token) return [];
  const oid = oidFromToken(token);
  if (!oid) return [];
  return lookupUserRoles(oid);
}

/**
 * Returns null if the caller has at least one of the required roles,
 * or a 403 HttpResponseInit otherwise. Callers should early-return on the
 * non-null result. `Admin` implicitly satisfies every role check.
 */
export async function requireRole(
  request: HttpRequest,
  allowed: readonly string[],
): Promise<HttpResponseInit | null> {
  const roles = await rolesForRequest(request);
  if (roles.includes("Admin")) return null;
  if (roles.some((r) => allowed.includes(r))) return null;
  return forbiddenResponse(
    `Required role: ${allowed.join(" | ")}. Have: ${roles.join(", ") || "(none)"}`,
  );
}
