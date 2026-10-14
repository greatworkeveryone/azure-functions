// How a MYOB call is written to dbo.MyobApiLog: secrets redacted, bodies
// clipped, the host dropped from the path. Pure; used by myob-api-log.ts.

const SENSITIVE_KEY = /secret|token|password|code|refresh|authorization/i;
const REDACTED = "[redacted]";
export const MAX_LOGGED_RESPONSE_CHARS = 32_000;
const TRUNCATED_MARKER = "…[truncated]";

/** Replaces the value of any key that looks like a credential, at any depth. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactSecrets(inner);
    }
    return out;
  }
  return value;
}

function redactedJson(text: string): string | null {
  try {
    return JSON.stringify(redactSecrets(JSON.parse(text)));
  } catch {
    return null;
  }
}

// What goes on the wire, and what is safe to store about it.
export function serialiseBody(body: unknown): { loggable: string | null; wire: string | undefined } {
  if (body === undefined) return { loggable: null, wire: undefined };
  if (body instanceof URLSearchParams) {
    return {
      loggable: JSON.stringify(redactSecrets(Object.fromEntries(body))),
      wire: body.toString(),
    };
  }
  const wire = typeof body === "string" ? body : JSON.stringify(body);
  return { loggable: redactedJson(wire) ?? "[non-JSON body not logged]", wire };
}

export function redactedResponse(text: string): string {
  const shown = redactedJson(text) ?? text;
  if (shown.length <= MAX_LOGGED_RESPONSE_CHARS) return shown;
  return shown.slice(0, MAX_LOGGED_RESPONSE_CHARS - TRUNCATED_MARKER.length) + TRUNCATED_MARKER;
}

// Path and query only: the host is implied, and credential-looking query
// values never reach the log.
export function loggablePath(url: string): string {
  try {
    const parsed = new URL(url);
    const query: string[] = [];
    parsed.searchParams.forEach((value, key) => {
      query.push(`${key}=${SENSITIVE_KEY.test(key) ? REDACTED : encodeURIComponent(value)}`);
    });
    return (parsed.pathname + (query.length ? `?${query.join("&")}` : "")).slice(0, 500);
  } catch {
    return "[unparseable url]";
  }
}

export function extractMyobUid(headers: Headers, text: string): string | null {
  const location = headers.get("Location");
  if (location) {
    const last = location.split("?")[0].replace(/\/+$/, "").split("/").pop();
    if (last) return last.slice(0, 100);
  }
  try {
    const uid = (JSON.parse(text) as { UID?: unknown } | null)?.UID;
    if (typeof uid === "string" && uid) return uid.slice(0, 100);
  } catch {
    // Not JSON (e.g. 204 No Content): no UID to record.
  }
  return null;
}
