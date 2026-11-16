// Inbound email triage (EB3): how often one person may ask. Every assign writes log rows, so a
// client stuck in a loop must not fill them; reads are cheap but still bounded. Per instance
// (src/rateLimit.ts); a refusal is a plain 429 the app treats as "try again in a moment".

import type { HttpResponseInit } from "@azure/functions";
import { tooManyRequests as sharedTooManyRequests } from "../rateLimitResponse";

export const READ_LIMIT = { limit: 120, windowMs: 60_000 } as const;
export const ASSIGN_LIMIT = { limit: 60, windowMs: 60_000 } as const;

export const tooManyRequests = (retryAfterMs: number): HttpResponseInit =>
  sharedTooManyRequests(retryAfterMs, "Too many requests. Try again in a moment.");
