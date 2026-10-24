import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../db";
import { addDays, dayEndUtc, daysBetween, dayStartUtc, darwinDay } from "./days";

// The daily roll-up (PLAN §14): one UsageDaily row per Darwin day x person x module x device class,
// plus a '*' row per person x day x device class holding the day's totals (distinct sessions, all
// views, all seconds). Recomputed from the raw rows for the days asked, so it can be run again and
// again, and a late heartbeat is picked up by the next run. A day that is re-rolled never shrinks:
// once raw rows past retention are purged the figures here are the only record, so a figure is only
// ever replaced by a larger one.

export const ROLLUP_RECENT_DAYS = 3;
export const MAX_ROLLUP_DAYS = 366;

export interface RollupCounts {
  days: number;
  inserted: number;
  updated: number;
}

const ROLLUP_SQL = `
  WITH seg AS (
    SELECT CAST(DATEADD(MINUTE, 570, v.EnteredAt) AS DATE) AS Day, s.UserId, v.ModuleKey, d.DeviceClass,
           v.SessionId, v.ActiveSeconds, v.IsContinuation
      FROM dbo.UsageViews v
      JOIN dbo.UsageSessions s ON s.SessionId = v.SessionId
      JOIN dbo.UsageDevices d ON d.DeviceId = s.DeviceId
     WHERE v.EnteredAt >= @FromUtc AND v.EnteredAt < @ToUtc
  ), agg AS (
    SELECT Day, UserId, ModuleKey, DeviceClass, COUNT(DISTINCT SessionId) AS Sessions,
           SUM(CASE WHEN IsContinuation = 0 THEN 1 ELSE 0 END) AS Views, SUM(ActiveSeconds) AS ActiveSeconds
      FROM seg GROUP BY Day, UserId, ModuleKey, DeviceClass
    UNION ALL
    SELECT Day, UserId, N'*', DeviceClass, COUNT(DISTINCT SessionId),
           SUM(CASE WHEN IsContinuation = 0 THEN 1 ELSE 0 END), SUM(ActiveSeconds)
      FROM seg GROUP BY Day, UserId, DeviceClass
  )
  MERGE dbo.UsageDaily AS t
  USING agg AS s ON t.Day = s.Day AND t.UserId = s.UserId AND t.ModuleKey = s.ModuleKey AND t.DeviceClass = s.DeviceClass
  WHEN MATCHED THEN UPDATE SET
    Sessions = CASE WHEN s.Sessions > t.Sessions THEN s.Sessions ELSE t.Sessions END,
    Views = CASE WHEN s.Views > t.Views THEN s.Views ELSE t.Views END,
    ActiveSeconds = CASE WHEN s.ActiveSeconds > t.ActiveSeconds THEN s.ActiveSeconds ELSE t.ActiveSeconds END,
    RolledUpAt = SYSUTCDATETIME()
  WHEN NOT MATCHED THEN INSERT (Day, UserId, ModuleKey, DeviceClass, Sessions, Views, ActiveSeconds)
    VALUES (s.Day, s.UserId, s.ModuleKey, s.DeviceClass, s.Sessions, s.Views, s.ActiveSeconds)
  OUTPUT $action AS Action;`;

/** Rolls up the Darwin days from..to (YYYY-MM-DD, inclusive). */
export async function rollUpDays(connection: Connection, from: string, to: string): Promise<RollupCounts> {
  const fromUtc = dayStartUtc(from);
  const toUtc = dayEndUtc(to);
  if (!fromUtc || !toUtc || from > to) throw new Error("rollUpDays needs real Darwin dates in order");
  const days = daysBetween(from, to) + 1;
  if (days > MAX_ROLLUP_DAYS) throw new Error(`rollUpDays: at most ${MAX_ROLLUP_DAYS} days at a time`);
  const rows = await executeQuery(connection, ROLLUP_SQL, [
    { name: "FromUtc", type: TYPES.DateTime2, value: fromUtc },
    { name: "ToUtc", type: TYPES.DateTime2, value: toUtc },
  ]);
  const inserted = rows.filter((row) => row.Action === "INSERT").length;
  return { days, inserted, updated: rows.length - inserted };
}

/** The timer's range: the last few Darwin days, today included, so a late heartbeat is caught. */
export function recentRollupRange(now: Date = new Date()): { from: string; to: string } {
  const to = darwinDay(now);
  return { from: addDays(to, 1 - ROLLUP_RECENT_DAYS), to };
}
