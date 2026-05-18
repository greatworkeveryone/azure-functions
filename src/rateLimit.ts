// In-memory, per-instance rate limiter. Azure Functions can scale out —
// for strict global limits, replace with Redis/Cosmos backend. This gives
// burst protection per instance.
//
// Token-bucket-ish: each key accrues a count within a sliding window; when
// the count exceeds `limit` we reject until the window expires. State lives
// in a single Map keyed by the caller's OID (or any caller-identifying
// string the handler picks). Expired entries are purged lazily on access so
// memory stays bounded under steady load.

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

const DEFAULT_LIMIT = 30;
const DEFAULT_WINDOW_MS = 60_000;

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

export interface RateLimitOpts {
  limit?: number;
  windowMs?: number;
}

export function checkRateLimit(
  key: string,
  opts?: RateLimitOpts,
): RateLimitResult {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
  const now = Date.now();

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    // First request in this window (or previous window expired).
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    purgeExpired(now);
    return { allowed: true };
  }

  if (existing.count >= limit) {
    return { allowed: false, retryAfterMs: Math.max(0, existing.resetAt - now) };
  }

  existing.count += 1;
  return { allowed: true };
}

/**
 * Test-only helper to wipe all in-memory state. Not exported via any
 * public route — only the test suite imports it.
 */
export function _resetRateLimitForTests(): void {
  buckets.clear();
}

function purgeExpired(now: number): void {
  // Cheap O(n) scan — fine for the small key cardinality this limiter
  // protects (per-user, per-instance). If we ever push beyond a few
  // thousand active users per instance, swap this for a min-heap by
  // resetAt or move to a Redis-backed implementation.
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}
