// A small in-memory sliding-window limiter for the anonymous tenant endpoints (TR3).
//
// Why in memory: the tenant endpoints are the only unauthenticated write path, so they need a limiter
// that costs no database round trip for a request that is going to be refused. The limits are PER
// INSTANCE: with N Function App instances the effective ceiling is up to N times the figure. The
// limits that must hold across instances (requests and photos per tenancy per day) are enforced from
// the database instead, in submit.ts and photos.ts. State is lost on restart, which only resets the
// short windows below. Memory is bounded: expired keys are purged and the map is capped.

const MAX_KEYS = 20_000;
const hitsByKey = new Map<string, number[]>();

function live(key: string, windowMs: number, now: number): number[] {
  const kept = (hitsByKey.get(key) ?? []).filter((t) => now - t < windowMs);
  if (kept.length > 0) hitsByKey.set(key, kept);
  else hitsByKey.delete(key);
  return kept;
}

function makeRoom(now: number): void {
  if (hitsByKey.size < MAX_KEYS) return;
  for (const [key, times] of hitsByKey) {
    if (times.length === 0 || now - times[times.length - 1] > 3_600_000) hitsByKey.delete(key);
  }
  // Still full: drop the oldest keys (insertion order) rather than refuse everyone.
  for (const key of hitsByKey.keys()) {
    if (hitsByKey.size < MAX_KEYS * 0.9) break;
    hitsByKey.delete(key);
  }
}

export interface WindowResult {
  allowed: boolean;
  retryAfterMs: number;
}

/** Counts a hit and says whether it is within `limit` per `windowMs`. A refused hit is not counted. */
export function hit(key: string, limit: number, windowMs: number, now: number = Date.now()): WindowResult {
  const times = live(key, windowMs, now);
  if (times.length >= limit) return { allowed: false, retryAfterMs: Math.max(1_000, windowMs - (now - times[0])) };
  makeRoom(now);
  times.push(now);
  hitsByKey.set(key, times);
  return { allowed: true, retryAfterMs: 0 };
}

/** True when `key` is already at `limit` in the window, without counting anything. */
export function isFull(key: string, limit: number, windowMs: number, now: number = Date.now()): WindowResult {
  const times = live(key, windowMs, now);
  return times.length >= limit
    ? { allowed: false, retryAfterMs: Math.max(1_000, windowMs - (now - times[0])) }
    : { allowed: true, retryAfterMs: 0 };
}

export function resetTenantLimiter(): void {
  hitsByKey.clear();
}
