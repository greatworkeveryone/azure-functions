import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../../db";
import type { UsagePeriod } from "../period";

// Overview (PLAN §14): active people, sessions a day, the median active session and active time by
// hour x weekday. Counts come from the roll-up (the '*' rows), so they survive the raw purge; the
// median and the heatmap read raw rows, so they cover the retention window.

export interface UsageOverviewDto {
  activePeople: number;
  activeSeconds: number;
  daily: { activePeople: number; activeSeconds: number; day: string; sessions: number }[];
  /** Weekday 0 = Monday. Darwin time. Only cells with time in them. */
  heatmap: { hour: number; seconds: number; weekday: number }[];
  medianSessionSeconds: number | null;
  period: { days: number; from: string; to: string };
  sessions: number;
}

const periodParams = (period: UsagePeriod) => [
  { name: "From", type: TYPES.VarChar, value: period.from },
  { name: "To", type: TYPES.VarChar, value: period.to },
];
const utcParams = (period: UsagePeriod) => [
  { name: "FromUtc", type: TYPES.DateTime2, value: period.fromUtc },
  { name: "ToUtc", type: TYPES.DateTime2, value: period.toUtc },
];

export async function loadUsageOverview(connection: Connection, period: UsagePeriod): Promise<UsageOverviewDto> {
  const daily = await executeQuery(
    connection,
    `SELECT CONVERT(CHAR(10), Day, 23) AS Day, SUM(Sessions) AS Sessions, COUNT(DISTINCT UserId) AS ActivePeople, SUM(ActiveSeconds) AS ActiveSeconds
       FROM dbo.UsageDaily WHERE ModuleKey = N'*' AND Day >= CAST(@From AS DATE) AND Day <= CAST(@To AS DATE)
      GROUP BY Day ORDER BY Day`,
    periodParams(period),
  );
  const people = await executeQuery(
    connection,
    `SELECT COUNT(DISTINCT UserId) AS N FROM dbo.UsageDaily WHERE ModuleKey = N'*' AND Day >= CAST(@From AS DATE) AND Day <= CAST(@To AS DATE)`,
    periodParams(period),
  );
  const median = await executeQuery(
    connection,
    `SELECT TOP 1 PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ActiveSeconds) OVER () AS Median
       FROM dbo.UsageSessions WHERE StartedAt >= @FromUtc AND StartedAt < @ToUtc AND ActiveSeconds > 0`,
    utcParams(period),
  );
  const heat = await executeQuery(
    connection,
    `SELECT DATEDIFF(DAY, '19000101', CAST(DATEADD(MINUTE, 570, EnteredAt) AS DATE)) % 7 AS Weekday,
            DATEPART(HOUR, DATEADD(MINUTE, 570, EnteredAt)) AS Hour, SUM(ActiveSeconds) AS Seconds
       FROM dbo.UsageViews WHERE EnteredAt >= @FromUtc AND EnteredAt < @ToUtc
      GROUP BY DATEDIFF(DAY, '19000101', CAST(DATEADD(MINUTE, 570, EnteredAt) AS DATE)) % 7, DATEPART(HOUR, DATEADD(MINUTE, 570, EnteredAt))
     HAVING SUM(ActiveSeconds) > 0`,
    utcParams(period),
  );
  const days = daily.map((row) => ({
    activePeople: Number(row.ActivePeople),
    activeSeconds: Number(row.ActiveSeconds),
    day: String(row.Day),
    sessions: Number(row.Sessions),
  }));
  const medianValue = median[0]?.Median;
  return {
    activePeople: Number(people[0]?.N ?? 0),
    activeSeconds: days.reduce((sum, row) => sum + row.activeSeconds, 0),
    daily: days,
    heatmap: heat.map((row) => ({ hour: Number(row.Hour), seconds: Number(row.Seconds), weekday: Number(row.Weekday) })),
    medianSessionSeconds: medianValue === null || medianValue === undefined ? null : Math.round(Number(medianValue)),
    period: { days: period.days, from: period.from, to: period.to },
    sessions: days.reduce((sum, row) => sum + row.sessions, 0),
  };
}
