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

// ── Sign-in (registerSelf) policy, SEC-10 ─────────────────────────────────────
// Counted only after the token is verified, so anonymous traffic can never
// fill a bucket. Per user 20/min; per source IP 120/min, high enough that a
// whole office behind one NAT signing in at 8am is never refused.
export const SIGN_IN_LIMITS = {
  perIp: { limit: 120, windowMs: 60_000 },
  perOid: { limit: 20, windowMs: 60_000 },
} as const;

export function checkSignInRateLimit(oid: string, ip: string): RateLimitResult {
  const byOid = checkRateLimit(`registerSelf:oid:${oid}`, SIGN_IN_LIMITS.perOid);
  if (!byOid.allowed) return byOid;
  return checkRateLimit(`registerSelf:ip:${ip}`, SIGN_IN_LIMITS.perIp);
}

// The caller can write any X-Forwarded-For it likes; the platform appends the
// address it actually saw, so the last hop is the one to trust. Azure adds a
// port to that entry, which would give every connection its own bucket.
export function clientIpFromHeaders(get: (name: string) => string | null): string {
  const hops = (get("x-forwarded-for") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  const raw = hops[hops.length - 1] ?? get("x-azure-clientip")?.trim() ?? "";
  if (!raw) return "unknown";
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(raw);
  if (bracketed) return bracketed[1];
  const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(raw);
  return ipv4WithPort ? ipv4WithPort[1] : raw;
}
