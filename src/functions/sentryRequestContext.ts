// What a captured exception may carry about its request. Credentials and the
// query string (MYOB OAuth `code`, Graph `validationToken`) never leave; the
// user is the Entra object id only (no email or name).

export interface SentryRequestLike {
  headers: { forEach(callback: (value: string, key: string) => void): void };
  method: string;
  url: string;
}

export interface SentryNormalizedRequest {
  headers: Record<string, string>;
  method: string;
  url: string;
}

export interface SentryRequestContext {
  normalizedRequest: SentryNormalizedRequest;
  user: { id: string } | null;
}

const REDACTED_HEADERS = new Set(["authorization", "x-app-token", "x-tenant-link", "cookie", "proxy-authorization"]);

/** The URL without query string or fragment; unparseable input is cut at "?" / "#". */
export function stripQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/)[0];
  }
}

export function sentryRequestContext(
  request: SentryRequestLike,
  token: string | null,
  oidFromToken: (token: string) => string | null,
): SentryRequestContext {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = REDACTED_HEADERS.has(key.toLowerCase()) ? "[redacted]" : value;
  });
  const oid = token ? oidFromToken(token) : null;
  return {
    normalizedRequest: { headers, method: request.method, url: stripQuery(request.url) },
    user: oid ? { id: oid } : null,
  };
}
