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
/** Upper bound on tracked keys: the anonymous tenant endpoints key by hashed address, so cardinality is not ours to choose. */
const MAX_KEYS = 20_000;
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
    capKeys();
    return { allowed: true };
  }

  if (existing.count >= limit) {
    return { allowed: false, retryAfterMs: Math.max(0, existing.resetAt - now) };
  }

  existing.count += 1;
  return { allowed: true };
}

/**
 * True when `key` is already at its limit in the current window, without counting a hit. Used where a refusal must
 * be checked before the work and only a failure should count (the tenant page's failed-link brake).
 */
export function isRateLimitFull(key: string, opts?: RateLimitOpts): RateLimitResult {
  const existing = buckets.get(key);
  const now = Date.now();
  if (!existing || existing.resetAt <= now || existing.count < (opts?.limit ?? DEFAULT_LIMIT)) return { allowed: true };
  return { allowed: false, retryAfterMs: Math.max(0, existing.resetAt - now) };
}

/**
 * Test-only helper to wipe all in-memory state. Not exported via any
 * public route — only the test suite imports it.
 */
export function _resetRateLimitForTests(): void {
  buckets.clear();
}

// Still over the cap after purging: drop the oldest keys (insertion order) rather than refuse everyone.
function capKeys(): void {
  if (buckets.size <= MAX_KEYS) return;
  for (const key of buckets.keys()) {
    if (buckets.size <= MAX_KEYS * 0.9) break;
    buckets.delete(key);
  }
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

// ── Sign-in (registerSelf) policy, SEC-10 ─────────────────────────────────────
// Counted only after the token is verified, so anonymous traffic can never
// fill a bucket. Per user 20/min; per source IP 120/min, high enough that a
// whole office behind one NAT signing in at 8am is never refused.
export const SIGN_IN_LIMITS = {
  perIp: { limit: 120, windowMs: 60_000 },
  perOid: { limit: 20, windowMs: 60_000 },
} as const;

/** Which limit refused a sign-in: the person's own, or the address's. */
export type SignInBucket = "user" | "address";

export type SignInRateLimitResult =
  | { allowed: true }
  | { allowed: false; bucket: SignInBucket; retryAfterMs: number };

/**
 * `address` is the caller's network address from access/clientIp.ts
 * clientAddress(), or "unknown" when that cannot be read: those callers share
 * one bucket, so nothing the caller wrote picks theirs.
 */
export function checkSignInRateLimit(oid: string, address: string): SignInRateLimitResult {
  const byOid = checkRateLimit(`registerSelf:oid:${oid}`, SIGN_IN_LIMITS.perOid);
  if (!byOid.allowed) return { ...byOid, bucket: "user" };
  const byAddress = checkRateLimit(`registerSelf:ip:${address}`, SIGN_IN_LIMITS.perIp);
  if (!byAddress.allowed) return { ...byAddress, bucket: "address" };
  return byAddress;
}
