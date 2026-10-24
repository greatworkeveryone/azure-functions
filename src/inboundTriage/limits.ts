// Inbound email triage (EB3): how often one person may ask. Every assign writes log rows, so a
// client stuck in a loop must not fill them; reads are cheap but still bounded. Per instance
// (src/rateLimit.ts); a refusal is a plain 429 the app treats as "try again in a moment".

import type { HttpResponseInit } from "@azure/functions";

export const READ_LIMIT = { limit: 120, windowMs: 60_000 } as const;
export const ASSIGN_LIMIT = { limit: 60, windowMs: 60_000 } as const;

export function tooManyRequests(retryAfterMs: number): HttpResponseInit {
  return {
    headers: { "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) },
    jsonBody: { error: "Too many requests. Try again in a moment." },
    status: 429,
  };
}
