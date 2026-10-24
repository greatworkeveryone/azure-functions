import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../../db";
import type { UsagePeriod } from "../period";

// Modules (PLAN §14): active time by module, and by module and role. From the roll-up.

export interface UsageModulesDto {
  byRole: { moduleKey: string; people: number; role: string | null; seconds: number }[];
  modules: { moduleKey: string; people: number; seconds: number; views: number }[];
  period: { days: number; from: string; to: string };
}

const WINDOW = `d.ModuleKey <> N'*' AND d.Day >= CAST(@From AS DATE) AND d.Day <= CAST(@To AS DATE)`;

export async function loadUsageModules(connection: Connection, period: UsagePeriod): Promise<UsageModulesDto> {
  const params = [
    { name: "From", type: TYPES.VarChar, value: period.from },
    { name: "To", type: TYPES.VarChar, value: period.to },
  ];
  const modules = await executeQuery(
    connection,
    `SELECT d.ModuleKey, SUM(d.ActiveSeconds) AS Seconds, COUNT(DISTINCT d.UserId) AS People, SUM(d.Views) AS Views
       FROM dbo.UsageDaily d WHERE ${WINDOW} GROUP BY d.ModuleKey ORDER BY SUM(d.ActiveSeconds) DESC`,
    params,
  );
  const byRole = await executeQuery(
    connection,
    `SELECT d.ModuleKey, LOWER(u.Role) AS Role, SUM(d.ActiveSeconds) AS Seconds, COUNT(DISTINCT d.UserId) AS People
       FROM dbo.UsageDaily d JOIN dbo.AppUsers u ON u.UserID = d.UserId WHERE ${WINDOW} GROUP BY d.ModuleKey, LOWER(u.Role)`,
    params,
  );
  return {
    byRole: byRole.map((row) => ({ moduleKey: String(row.ModuleKey), people: Number(row.People), role: (row.Role as string | null) ?? null, seconds: Number(row.Seconds) })),
    modules: modules.map((row) => ({ moduleKey: String(row.ModuleKey), people: Number(row.People), seconds: Number(row.Seconds), views: Number(row.Views) })),
    period: { days: period.days, from: period.from, to: period.to },
  };
}
