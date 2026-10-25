// Contractor suggestions (SC-AI3): how often one person may ask or record. Every ask writes a
// set and its items to the log, so a client stuck in a loop must not be able to fill it. A person
// opening screens asks a handful of times a minute at most; these are generous, per instance
// (src/rateLimit.ts), and a refusal is a plain 429 the app treats as "no suggestions".

import type { HttpResponseInit } from "@azure/functions";

export const SUGGEST_LIMIT = { limit: 30, windowMs: 60_000 } as const;
export const OUTCOME_LIMIT = { limit: 60, windowMs: 60_000 } as const;

export function tooManyRequests(retryAfterMs: number): HttpResponseInit {
  return {
    headers: { "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) },
    jsonBody: { error: "Too many requests. Try again in a moment." },
    status: 429,
  };
}
