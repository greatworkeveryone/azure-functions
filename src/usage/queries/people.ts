import { TYPES, type Connection } from "tedious";
import { executeQuery, type SqlParam } from "../../db";
import type { UsagePeriod } from "../period";

// People (PLAN §14): per person, sessions, active time, last active day, the device classes they
// used, their top modules and a calendar of active seconds by day. All from the roll-up.

export interface UsagePersonDto {
  activeSeconds: number;
  calendar: { day: string; seconds: number }[];
  devices: { deviceClass: string; seconds: number }[];
  lastActiveDay: string | null;
  name: string;
  role: string | null;
  sessions: number;
  topModules: { moduleKey: string; seconds: number }[];
  userId: number;
}

export interface UsagePeopleFilter {
  /** Count only these modules everywhere: time, last day, calendar, devices and top pages. Null for all modules. */
  moduleKeys: readonly string[] | null;
  /** Only these roles (lower case); null for everyone. */
  roles: readonly string[] | null;
  userId: number | null;
}

const TOP_MODULES = 3;

// Everything that narrows the people is a bound parameter: the person as @UserId, the roles as a JSON list in @Roles
// and the modules as a JSON list in @Keys (read with OPENJSON). Null means no narrowing; an empty role list matches nobody.
// With @Keys null a person's time is the all-modules '*' row. With @Keys set it is the sum of those modules' rows only,
// so a view limited to some modules (the CFO's Finance view) never counts, dates or classifies time anywhere else.
// Sessions are per module row, so across several modules the day's figure is the largest one: sessions that used the
// allowed pages, at least, never more than there were.
const PEOPLE_BASE = `FROM dbo.UsageDaily d JOIN dbo.AppUsers u ON u.UserID = d.UserId
     WHERE d.Day >= CAST(@From AS DATE) AND d.Day <= CAST(@To AS DATE)
       AND (@UserId IS NULL OR d.UserId = @UserId)
       AND (@Roles IS NULL OR LOWER(u.Role) IN (SELECT value FROM OPENJSON(@Roles)))`;
const IN_SCOPE = `((@Keys IS NULL AND d.ModuleKey = N'*') OR (@Keys IS NOT NULL AND d.ModuleKey IN (SELECT value FROM OPENJSON(@Keys))))`;

export function peopleParams(period: UsagePeriod, filter: { moduleKeys?: readonly string[] | null; roles: readonly string[] | null; userId: number | null }): SqlParam[] {
  return [
    { name: "From", type: TYPES.VarChar, value: period.from },
    { name: "To", type: TYPES.VarChar, value: period.to },
    { name: "UserId", type: TYPES.Int, value: filter.userId },
    { name: "Roles", type: TYPES.NVarChar, value: filter.roles === null ? null : JSON.stringify(filter.roles) },
    { name: "Keys", type: TYPES.NVarChar, value: filter.moduleKeys ? JSON.stringify(filter.moduleKeys) : null },
  ];
}

export async function loadUsagePeople(connection: Connection, period: UsagePeriod, filter: UsagePeopleFilter): Promise<UsagePersonDto[]> {
  const params = peopleParams(period, filter);
  const totals = await executeQuery(
    connection,
    `SELECT x.UserId, u.DisplayName, LOWER(u.Role) AS Role, SUM(x.Sessions) AS Sessions, SUM(x.ActiveSeconds) AS ActiveSeconds, CONVERT(CHAR(10), MAX(x.Day), 23) AS LastDay
       FROM (SELECT d.UserId, d.Day, d.DeviceClass, MAX(d.Sessions) AS Sessions, SUM(d.ActiveSeconds) AS ActiveSeconds
               ${PEOPLE_BASE} AND ${IN_SCOPE} GROUP BY d.UserId, d.Day, d.DeviceClass) x
       JOIN dbo.AppUsers u ON u.UserID = x.UserId
      GROUP BY x.UserId, u.DisplayName, u.Role ORDER BY SUM(x.ActiveSeconds) DESC`,
    params,
  );
  const classes = await executeQuery(
    connection,
    `SELECT d.UserId, d.DeviceClass, SUM(d.ActiveSeconds) AS Seconds ${PEOPLE_BASE} AND ${IN_SCOPE} GROUP BY d.UserId, d.DeviceClass`,
    params,
  );
  const modules = await executeQuery(
    connection,
    `SELECT d.UserId, d.ModuleKey, SUM(d.ActiveSeconds) AS Seconds ${PEOPLE_BASE} AND d.ModuleKey <> N'*' AND (@Keys IS NULL OR d.ModuleKey IN (SELECT value FROM OPENJSON(@Keys))) GROUP BY d.UserId, d.ModuleKey`,
    params,
  );
  const calendar = await executeQuery(
    connection,
    `SELECT d.UserId, CONVERT(CHAR(10), d.Day, 23) AS Day, SUM(d.ActiveSeconds) AS Seconds ${PEOPLE_BASE} AND ${IN_SCOPE} GROUP BY d.UserId, d.Day ORDER BY d.Day`,
    params,
  );
  const allowed = filter.moduleKeys ? new Set(filter.moduleKeys) : null;
  return totals.map((row) => {
    const userId = Number(row.UserId);
    return {
      activeSeconds: Number(row.ActiveSeconds),
      calendar: calendar.filter((entry) => Number(entry.UserId) === userId).map((entry) => ({ day: String(entry.Day), seconds: Number(entry.Seconds) })),
      devices: classes.filter((entry) => Number(entry.UserId) === userId).map((entry) => ({ deviceClass: String(entry.DeviceClass), seconds: Number(entry.Seconds) })),
      lastActiveDay: row.LastDay ? String(row.LastDay) : null,
      name: String(row.DisplayName ?? ""),
      role: (row.Role as string | null) ?? null,
      sessions: Number(row.Sessions),
      topModules: modules
        .filter((entry) => Number(entry.UserId) === userId && (allowed === null || allowed.has(String(entry.ModuleKey))))
        .map((entry) => ({ moduleKey: String(entry.ModuleKey), seconds: Number(entry.Seconds) }))
        .sort((a, b) => b.seconds - a.seconds)
        .slice(0, TOP_MODULES),
      userId,
    };
  });
}
