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

export function errorResponse(message: string, details: string): HttpResponseInit {
  return {
    status: 500,
    jsonBody: { error: message, details },
  };
}

// ── Role extraction ──────────────────────────────────────────────────────────
// Decodes the JWT payload to read the Entra `roles` claim (populated from
// app-role assignments on the app registration). We deliberately don't
// signature-verify here: the same token is later used to authenticate to
// Azure SQL, which Entra verifies end-to-end, so a forged token can't reach
// the actual resources. If the security boundary grows (e.g. endpoints that
// don't hit SQL), swap this for proper JWKS verification via `jose`.

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

export function rolesFromToken(token: string): string[] {
  const payload = decodeJwtPayload(token);
  const raw = payload?.roles;
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is string => typeof r === "string");
}

/**
 * Returns null if the token carries at least one of the required roles,
 * or a 403 response otherwise. Callers should early-return on the non-null
 * result. `Admin` is implicitly allowed for every call — it's the superset
 * role, not a distinct permission.
 */
export function requireRole(
  token: string,
  allowed: readonly string[],
): HttpResponseInit | null {
  const roles = rolesFromToken(token);
  if (roles.includes("Admin")) return null;
  if (roles.some((r) => allowed.includes(r))) return null;
  return forbiddenResponse(
    `Required role: ${allowed.join(" | ")}. Have: ${roles.join(", ") || "(none)"}`,
  );
}
