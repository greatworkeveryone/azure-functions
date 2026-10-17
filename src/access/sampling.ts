// In-memory sampling for the access log, per Functions instance. Recording every
// request would double the database work of the whole app; decision 15 needs
// sign-ins, money actions, one request per person, network and device per 15
// minutes (so the out-of-hours and country rules see ordinary use, and a second
// network or device is never hidden in the first one's sample) and bursts. Bursts are
// counted here because sampled rows can't show them. Flex Consumption scales
// out, so a burst split across instances can go unseen here; the App Insights
// alert in docs/runbooks/monitoring.md counts across all of them.

export const SAMPLE_INTERVAL_MS = 15 * 60_000;
export const BURST_WINDOW_MS = 5 * 60_000;
export const BURST_LIMIT = 300;

// Bounded: past this many tracked people, expired entries are swept.
const SWEEP_AT = 5_000;

const lastSampled = new Map<string, number>();
const burstWindows = new Map<string, { count: number; resetAt: number }>();

function sweep(now: number): void {
  if (lastSampled.size > SWEEP_AT) {
    for (const [key, at] of lastSampled) if (now - at >= SAMPLE_INTERVAL_MS) lastSampled.delete(key);
  }
  if (burstWindows.size > SWEEP_AT) {
    for (const [oid, w] of burstWindows) if (w.resetAt <= now) burstWindows.delete(oid);
  }
}

/** True for the first request per key (person + network + device) in each
 *  15-minute interval. */
export function shouldSampleRequest(key: string, now: number): boolean {
  const last = lastSampled.get(key);
  if (last !== undefined && now - last < SAMPLE_INTERVAL_MS) return false;
  lastSampled.set(key, now);
  sweep(now);
  return true;
}

/** Counts one request; true only on the request that takes a person over
 *  BURST_LIMIT within one 5-minute window, so a burst is recorded once. */
export function countForBurst(oid: string, now: number): boolean {
  const window = burstWindows.get(oid);
  if (!window || window.resetAt <= now) {
    burstWindows.set(oid, { count: 1, resetAt: now + BURST_WINDOW_MS });
    sweep(now);
    return false;
  }
  window.count += 1;
  return window.count === BURST_LIMIT + 1;
}

export function _resetSamplingForTests(): void {
  lastSampled.clear();
  burstWindows.clear();
}
