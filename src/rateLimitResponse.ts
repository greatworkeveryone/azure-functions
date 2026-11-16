// The 429 for a caller rateLimit.ts refused. Kept apart from rateLimit.ts because many tests
// replace that module wholesale with a mock.

import type { HttpResponseInit } from "@azure/functions";

/** Retry-After is in whole seconds, never below one. */
export function tooManyRequests(retryAfterMs: number, error = "Rate limit exceeded"): HttpResponseInit {
  return {
    headers: { "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) },
    jsonBody: { error },
    status: 429,
  };
}
