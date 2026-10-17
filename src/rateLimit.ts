// In-memory, per-instance rate limiter. Azure Functions can scale out —
// for strict global limits, replace with Redis/Cosmos backend. This gives
// burst protection per instance.
//
// Token-bucket-ish: each key accrues a count within a sliding window; when
// the count exceeds `limit` we reject until the window expires. State lives
// in a single Map keyed by the caller's OID (or any caller-identifying
// string the handler picks). Expired entries are purged lazily on access so
// memory stays bounded under steady load.

import { BlockList, isIP, isIPv4 } from "node:net";

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

// The caller's address: the rightmost PUBLIC entry of X-Forwarded-For. The
// header is unverified — a caller can send its own, and a proxy that appends
// leaves the caller's value on the left and the address it saw on the right —
// so nothing the caller writes can land to the right of the platform's entry,
// and private hops the platform adds after it are skipped. Unreadable entries
// are skipped; ports (Azure appends one) and brackets are dropped. Same rule as
// the access log's clientAddress() (lane S, src/access/clientIp.ts); the
// integrator keeps one copy when the lanes merge.
const NOT_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16],
] as const) NOT_PUBLIC.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [["::", 127], ["fc00::", 7], ["fe80::", 10]] as const) NOT_PUBLIC.addSubnet(net, prefix, "ipv6");

function normaliseForwardedEntry(raw: string): string | null {
  let entry = raw.trim().replace(/^"|"$/g, "");
  const bracketed = entry.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) entry = bracketed[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(entry)) entry = entry.slice(0, entry.lastIndexOf(":"));
  const mapped = entry.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) entry = mapped[1];
  if (!isIP(entry)) return null;
  return isIPv4(entry) ? entry : entry.toLowerCase();
}

export function clientIpFromHeaders(get: (name: string) => string | null): string {
  const entries = (get("x-forwarded-for") ?? "")
    .split(",")
    .map(normaliseForwardedEntry)
    .filter((entry): entry is string => entry !== null);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (!NOT_PUBLIC.check(entries[i], isIPv4(entries[i]) ? "ipv4" : "ipv6")) return entries[i];
  }
  return entries[entries.length - 1] ?? "unknown";
}
