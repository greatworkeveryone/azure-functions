import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../../db";
import type { UsagePeriod } from "../period";

// Devices (PLAN §14): which kind of device is used overall, by each role in each module (the
// answer to "do facilities use the company tablet or their phones for inspections?"), and the
// devices an admin has named, with what they are used for. Class shares come from the roll-up; the
// per-device parts read raw rows, so they cover the retention window.

export interface UsageDeviceRow {
  browser: string;
  deviceClass: string;
  deviceId: string;
  label: string | null;
  lastSeenAt: string;
  modules: { moduleKey: string; seconds: number }[];
  os: string;
  people: number;
  seconds: number;
}

export interface UsageDevicesDto {
  classShare: { deviceClass: string; people: number; seconds: number }[];
  named: UsageDeviceRow[];
  period: { days: number; from: string; to: string };
  roleModule: { deviceClass: string; moduleKey: string; people: number; role: string | null; seconds: number }[];
  /** Unnamed browsers used by two or more people in the period: likely shared, so worth naming. */
  sharedUnnamed: UsageDeviceRow[];
}

const MAX_SHARED_UNNAMED = 10;

const DEVICE_COLUMNS = `dev.DeviceId, dev.Label, dev.DeviceClass, dev.BrowserFamily, dev.OsFamily, dev.LastSeenAt,
  COUNT(DISTINCT CASE WHEN v.ViewId IS NOT NULL THEN s.UserId END) AS People, COALESCE(SUM(v.ActiveSeconds), 0) AS Seconds`;
const DEVICE_FROM = `FROM dbo.UsageDevices dev
  LEFT JOIN dbo.UsageSessions s ON s.DeviceId = dev.DeviceId
  LEFT JOIN dbo.UsageViews v ON v.SessionId = s.SessionId AND v.EnteredAt >= @FromUtc AND v.EnteredAt < @ToUtc`;
const GROUP_BY = "GROUP BY dev.DeviceId, dev.Label, dev.DeviceClass, dev.BrowserFamily, dev.OsFamily, dev.LastSeenAt";

const toRow = (row: Record<string, unknown>): UsageDeviceRow => ({
  browser: String(row.BrowserFamily),
  deviceClass: String(row.DeviceClass),
  deviceId: String(row.DeviceId),
  label: (row.Label as string | null) ?? null,
  lastSeenAt: (row.LastSeenAt as Date).toISOString(),
  modules: [],
  os: String(row.OsFamily),
  people: Number(row.People),
  seconds: Number(row.Seconds),
});

export async function loadUsageDevices(connection: Connection, period: UsagePeriod): Promise<UsageDevicesDto> {
  const days = [
    { name: "From", type: TYPES.VarChar, value: period.from },
    { name: "To", type: TYPES.VarChar, value: period.to },
  ];
  const utc = [
    { name: "FromUtc", type: TYPES.DateTime2, value: period.fromUtc },
    { name: "ToUtc", type: TYPES.DateTime2, value: period.toUtc },
  ];
  const share = await executeQuery(
    connection,
    `SELECT DeviceClass, SUM(ActiveSeconds) AS Seconds, COUNT(DISTINCT UserId) AS People FROM dbo.UsageDaily
      WHERE ModuleKey = N'*' AND Day >= CAST(@From AS DATE) AND Day <= CAST(@To AS DATE) GROUP BY DeviceClass`,
    days,
  );
  const roleModule = await executeQuery(
    connection,
    `SELECT LOWER(u.Role) AS Role, d.ModuleKey, d.DeviceClass, SUM(d.ActiveSeconds) AS Seconds, COUNT(DISTINCT d.UserId) AS People
       FROM dbo.UsageDaily d JOIN dbo.AppUsers u ON u.UserID = d.UserId
      WHERE d.ModuleKey <> N'*' AND d.Day >= CAST(@From AS DATE) AND d.Day <= CAST(@To AS DATE)
      GROUP BY LOWER(u.Role), d.ModuleKey, d.DeviceClass`,
    days,
  );
  const named = (await executeQuery(connection, `SELECT ${DEVICE_COLUMNS} ${DEVICE_FROM} WHERE dev.Label IS NOT NULL ${GROUP_BY} ORDER BY dev.Label`, utc)).map(toRow);
  const shared = (
    await executeQuery(
      connection,
      `SELECT TOP (${MAX_SHARED_UNNAMED}) ${DEVICE_COLUMNS} ${DEVICE_FROM} WHERE dev.Label IS NULL AND dev.IsPersistent = 1 ${GROUP_BY}
       HAVING COUNT(DISTINCT CASE WHEN v.ViewId IS NOT NULL THEN s.UserId END) >= 2 ORDER BY COALESCE(SUM(v.ActiveSeconds), 0) DESC`,
      utc,
    )
  ).map(toRow);
  if (named.length > 0) {
    const modules = await executeQuery(
      connection,
      `SELECT s.DeviceId, v.ModuleKey, SUM(v.ActiveSeconds) AS Seconds
         FROM dbo.UsageViews v JOIN dbo.UsageSessions s ON s.SessionId = v.SessionId JOIN dbo.UsageDevices dev ON dev.DeviceId = s.DeviceId
        WHERE dev.Label IS NOT NULL AND v.EnteredAt >= @FromUtc AND v.EnteredAt < @ToUtc GROUP BY s.DeviceId, v.ModuleKey ORDER BY SUM(v.ActiveSeconds) DESC`,
      utc,
    );
    for (const device of named) {
      device.modules = modules.filter((row) => row.DeviceId === device.deviceId).map((row) => ({ moduleKey: String(row.ModuleKey), seconds: Number(row.Seconds) }));
    }
  }
  return {
    classShare: share.map((row) => ({ deviceClass: String(row.DeviceClass), people: Number(row.People), seconds: Number(row.Seconds) })),
    named,
    period: { days: period.days, from: period.from, to: period.to },
    roleModule: roleModule.map((row) => ({
      deviceClass: String(row.DeviceClass),
      moduleKey: String(row.ModuleKey),
      people: Number(row.People),
      role: (row.Role as string | null) ?? null,
      seconds: Number(row.Seconds),
    })),
    sharedUnnamed: shared,
  };
}
