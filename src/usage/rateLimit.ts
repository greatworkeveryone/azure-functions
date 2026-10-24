// A per-person ceiling on batches, so a stuck or hostile client cannot flood the tables. A heartbeat
// goes out every 30 to 60 seconds, plus a send when the page is hidden or the route changes, so 30 in
// five minutes is generous for a real browser. Held in this instance's memory: with several
// instances the ceiling is per instance, which is enough for a flood guard.

const WINDOW_MS = 5 * 60 * 1000;
export const MAX_BATCHES_PER_WINDOW = 30;

const recent = new Map<number, number[]>();

/** True when this person may send a batch now; counts it when so. */
export function allowUsageBatch(userId: number, nowMs: number = Date.now()): boolean {
  const kept = (recent.get(userId) ?? []).filter((at) => nowMs - at < WINDOW_MS);
  if (kept.length >= MAX_BATCHES_PER_WINDOW) {
    recent.set(userId, kept);
    return false;
  }
  kept.push(nowMs);
  recent.set(userId, kept);
  if (recent.size > 5000) for (const [id, times] of recent) if (times.every((at) => nowMs - at >= WINDOW_MS)) recent.delete(id);
  return true;
}

export function resetUsageRateLimit(): void {
  recent.clear();
}
