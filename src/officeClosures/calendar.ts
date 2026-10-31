// The business calendar: active office closures from dbo.OfficeClosures, expanded to Darwin day keys and unioned
// with ESCALATION_HOLIDAYS (kept as a fallback). Load once per request or sweep and pass the result down; a short
// in-process cache keeps a busy host from asking the database every time.

import type { Connection } from "tedious";
import { closeConnection, createServiceRequestConnection, executeQuery } from "../db";
import { addCalendarDays, parseHolidays, setLoadedClosureDays, type Holidays } from "../escalation/businessTime";
import type { ClosureSpan, OfficeCalendar } from "./status";

const CACHE_MS = 5 * 60_000;
const FAILURE_CACHE_MS = 60_000;
/** One closure never spans more than this many days (a typo guard; the save endpoint enforces it too). */
export const MAX_CLOSURE_DAYS = 120;

let cache: { at: number; calendar: OfficeCalendar; env: string } | null = null;

export function clearOfficeCalendarCache(): void {
  cache = null;
  setLoadedClosureDays(new Set());
}

const dateKey = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
};

/** Every Darwin day key from startsOn to endsOn inclusive (nothing for a reversed or over-long range). */
export function expandClosure(startsOn: string, endsOn: string): string[] {
  const days: string[] = [];
  for (let day = startsOn; day <= endsOn && days.length <= MAX_CLOSURE_DAYS; day = addCalendarDays(day, 1)) days.push(day);
  return days.length > MAX_CLOSURE_DAYS ? [] : days;
}

export function buildCalendar(closures: ClosureSpan[], env: NodeJS.ProcessEnv = process.env): OfficeCalendar {
  const days = new Set<string>(parseHolidays(env.ESCALATION_HOLIDAYS).holidays);
  for (const closure of closures) for (const day of expandClosure(closure.startsOn, closure.endsOn)) days.add(day);
  return { closures, holidays: days };
}

/** The calendar with the closures in force: database rows, plus ESCALATION_HOLIDAYS. Falls back to the env alone if the table can't be read. */
export async function loadOfficeCalendar(connection: Connection, env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): Promise<OfficeCalendar> {
  const envKey = env.ESCALATION_HOLIDAYS ?? "";
  if (cache && cache.env === envKey && now - cache.at < CACHE_MS) return cache.calendar;
  let closures: ClosureSpan[] = [];
  let failed = false;
  try {
    const rows = await executeQuery(connection, `SELECT StartsOn, EndsOn, Label FROM dbo.OfficeClosures WHERE ArchivedAt IS NULL ORDER BY StartsOn`);
    for (const row of rows ?? []) {
      const startsOn = dateKey(row.StartsOn);
      const endsOn = dateKey(row.EndsOn);
      if (startsOn && endsOn) closures.push({ endsOn, label: String(row.Label ?? ""), startsOn });
    }
  } catch {
    failed = true;
    closures = [];
  }
  const calendar = buildCalendar(closures, env);
  setLoadedClosureDays(new Set(closures.flatMap((c) => expandClosure(c.startsOn, c.endsOn))));
  cache = { at: failed ? now - (CACHE_MS - FAILURE_CACHE_MS) : now, calendar, env: envKey };
  return calendar;
}

/** Just the day set, for the engine's `holidays` parameter. */
export async function loadBusinessCalendar(connection: Connection, env: NodeJS.ProcessEnv = process.env): Promise<Holidays> {
  return (await loadOfficeCalendar(connection, env)).holidays;
}

/** For timers that decide before they open a connection (the digests): load the closures on a short-lived service connection. */
export async function primeOfficeClosures(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let connection: Connection | undefined;
  try {
    connection = await createServiceRequestConnection();
    await loadOfficeCalendar(connection, env);
  } catch {
    // The env holidays still apply.
  } finally {
    if (connection) closeConnection(connection);
  }
}
