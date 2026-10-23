import { oidFromToken } from "./auth";

/** Who is calling, from the Entra token already checked by requireRole: the id and the name stamped on a write. */
export function callerFromToken(token: string): { id: string; name: string } {
  const claims = decodeClaims(token);
  const id = oidFromToken(token) ?? (typeof claims?.preferred_username === "string" ? claims.preferred_username : "unknown");
  const name = typeof claims?.name === "string" ? claims.name : typeof claims?.preferred_username === "string" ? claims.preferred_username : "Unknown user";
  return { id, name };
}

function decodeClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "="), "base64").toString("utf8"));
  } catch {
    return null;
  }
}
