import { darwinDay } from "./days";
import type { UsageViewInput } from "./validate";

// Active time is only ever counted at the pace of the server's clock (privacy review M2). A browser says how many
// seconds it was in use; the server will not accept more than could have passed since it last heard from that
// session, and never more than 24 hours for one person on one Darwin day, however many sessions they send. Without
// this a person could raise their own figures, which a manager may be shown against their name.

export const HEARTBEAT_GRACE_SECONDS = 60;
export const DAILY_SECONDS_CAP = 86_400;

/** The most seconds a batch may add: the time since the session's last heartbeat (or its start), plus a minute. */
export function allowanceSince(since: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - since.getTime()) / 1000)) + HEARTBEAT_GRACE_SECONDS;
}

/**
 * What a batch may add to an existing session: no more than the time since its last heartbeat plus a minute, and
 * never so much that the session's total passes the time since it began plus a minute. The second limit is what
 * stops many small batches each earning a fresh minute of grace.
 */
export function sessionAllowance(session: { activeSeconds: number; lastHeartbeatAt: Date; startedAt: Date }, now: Date): number {
  const sinceHeartbeat = allowanceSince(session.lastHeartbeatAt, now);
  const sinceStart = allowanceSince(session.startedAt, now) - session.activeSeconds;
  return Math.max(0, Math.min(sinceHeartbeat, sinceStart));
}

const total = (views: readonly UsageViewInput[]): number => views.reduce((sum, item) => sum + item.activeSeconds, 0);

/** Scales the views down in proportion so they add up to no more than the allowance. Within it, nothing changes. */
export function scaleToAllowance(views: readonly UsageViewInput[], allowance: number): UsageViewInput[] {
  const sum = total(views);
  if (sum <= allowance) return [...views];
  const room = Math.max(0, allowance);
  return views.map((item) => ({ ...item, activeSeconds: Math.floor((item.activeSeconds * room) / sum) }));
}

/** Holds each Darwin day to the cap, counting what the person already has on it (from all their sessions). */
export function limitPerDay(views: readonly UsageViewInput[], used: ReadonlyMap<string, number>, cap: number = DAILY_SECONDS_CAP): UsageViewInput[] {
  const days = [...new Set(views.map((item) => darwinDay(item.enteredAt)))];
  const scaled = new Map<number, number>();
  for (const day of days) {
    const group = views.filter((item) => darwinDay(item.enteredAt) === day);
    for (const item of scaleToAllowance(group, cap - (used.get(day) ?? 0))) scaled.set(item.seq, item.activeSeconds);
  }
  return views.map((item) => ({ ...item, activeSeconds: scaled.get(item.seq) ?? item.activeSeconds }));
}
