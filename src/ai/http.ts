// What a route answers when runAi turned a call away for sending too many (SC-AI1): HTTP 429,
// with Retry-After, and a body with nothing but the typed code and a plain sentence. Every
// route that calls runAi checks its result with this before building its own answer.

import type { HttpResponseInit } from "@azure/functions";
import type { AiResult } from "./types";

/** A minute is how far back the limit looks, so a minute is when trying again can work. */
export const THROTTLED_RETRY_AFTER_SECONDS = 60;

/** The 429 for a throttled result, or null for any other result. */
export function throttledResponse(result: AiResult): HttpResponseInit | null {
  if (result.ok || !result.meta.throttled) return null;
  return {
    headers: { "Cache-Control": "no-store", "Retry-After": String(THROTTLED_RETRY_AFTER_SECONDS) },
    jsonBody: { code: result.refusal.code, error: result.refusal.message },
    status: 429,
  };
}
