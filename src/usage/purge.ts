import { TYPES, type Connection } from "tedious";
import { executeQuery, type SqlParam } from "../db";
import { addDays, dayStartUtc, darwinDay } from "./days";

// The purge (PLAN §14, database-safety rule 2). It deletes only RAW usage rows older than the
// retention window, chosen positively: a view goes only when its person's roll-up for its Darwin day
// exists, was made after the day ended and after the session's last heartbeat (so nothing is lost
// that the roll-up has not counted). A session goes only when it is past the window, has no views
// left and that person's own roll-up for its Darwin day was made after it ended (nobody else's counts). Devices are
// never deleted. A person's daily totals (UsageDaily) go once their whole day is older than the daily retention
// (USAGE_DAILY_RETENTION_DAYS, always at least the raw retention), whole days at a time. Whether anything is deleted is the caller's choice (USAGE_PURGE_ENABLED, with
// USAGE_PURGE_DRY_RUN to count only); a run deletes at most MAX_PER_RUN rows of each kind.

export const BATCH_SIZE = 5000;
export const MAX_BATCHES = 40;
export const MAX_PER_RUN = BATCH_SIZE * MAX_BATCHES;
/** Whole days of daily totals removed per batch. */
export const DAY_BATCH = 5;

export interface PurgeCounts {
  cutoffDay: string;
  dailyCutoffDay: string;
  dailyDeleted: number;
  dailyEligible: number;
  dryRun: boolean;
  sessionsDeleted: number;
  sessionsEligible: number;
  viewsDeleted: number;
  viewsEligible: number;
}

// "The day's roll-up was made after the Darwin day ended": the day's end in UTC is the next midnight less 9h30.

const ELIGIBLE_VIEWS = `
  FROM dbo.UsageViews v
  JOIN dbo.UsageSessions s ON s.SessionId = v.SessionId
  JOIN dbo.UsageDevices dev ON dev.DeviceId = s.DeviceId
 WHERE v.EnteredAt < @CutoffUtc
   AND EXISTS (
     SELECT 1 FROM dbo.UsageDaily d
      WHERE d.Day = CAST(DATEADD(MINUTE, 570, v.EnteredAt) AS DATE) AND d.UserId = s.UserId
        AND d.ModuleKey = N'*' AND d.DeviceClass = dev.DeviceClass
        AND d.RolledUpAt >= DATEADD(MINUTE, -570, DATEADD(DAY, 1, CAST(d.Day AS DATETIME2(3))))
        AND d.RolledUpAt >= s.LastHeartbeatAt)`;

const ELIGIBLE_SESSIONS = `
  FROM dbo.UsageSessions s
 WHERE s.StartedAt < @CutoffUtc AND s.LastHeartbeatAt < @CutoffUtc
   AND NOT EXISTS (SELECT 1 FROM dbo.UsageViews v WHERE v.SessionId = s.SessionId)
   AND EXISTS (
     SELECT 1 FROM dbo.UsageDaily d
      WHERE d.Day = CAST(DATEADD(MINUTE, 570, s.StartedAt) AS DATE) AND d.UserId = s.UserId AND d.RolledUpAt >= DATEADD(MINUTE, -570, DATEADD(DAY, 1, CAST(d.Day AS DATETIME2(3)))))`;

const count = async (connection: Connection, sql: string, cutoffUtc: Date): Promise<number> => {
  const rows = await executeQuery(connection, `SELECT COUNT_BIG(*) AS N ${sql}`, [{ name: "CutoffUtc", type: TYPES.DateTime2, value: cutoffUtc }]);
  return Number(rows[0]?.N ?? 0);
};

async function deleteBatches(connection: Connection, statement: string, cutoffUtc: Date): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const rows = await executeQuery(connection, statement, [
      { name: "CutoffUtc", type: TYPES.DateTime2, value: cutoffUtc },
      { name: "Batch", type: TYPES.Int, value: BATCH_SIZE },
    ]);
    const removed = Number(rows[0]?.Removed ?? 0);
    total += removed;
    if (removed < BATCH_SIZE) break;
  }
  return total;
}

const DAILY_ELIGIBLE = "FROM dbo.UsageDaily WHERE Day < CAST(@CutoffDay AS DATE)";

const dailyParams = (cutoffDay: string): SqlParam[] => [{ name: "CutoffDay", type: TYPES.VarChar, value: cutoffDay }];

async function purgeDaily(connection: Connection, cutoffDay: string, dryRun: boolean): Promise<{ deleted: number; eligible: number }> {
  const rows = await executeQuery(connection, `SELECT COUNT_BIG(*) AS N ${DAILY_ELIGIBLE}`, dailyParams(cutoffDay));
  const eligible = Number(rows[0]?.N ?? 0);
  if (dryRun) return { deleted: 0, eligible };
  let deleted = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const result = await executeQuery(
      connection,
      `DELETE FROM dbo.UsageDaily WHERE Day IN (SELECT DISTINCT TOP (@Days) Day ${DAILY_ELIGIBLE} ORDER BY Day); SELECT @@ROWCOUNT AS Removed;`,
      [...dailyParams(cutoffDay), { name: "Days", type: TYPES.Int, value: DAY_BATCH }],
    );
    const removed = Number(result[0]?.Removed ?? 0);
    deleted += removed;
    if (removed === 0) break;
  }
  return { deleted, eligible };
}

export async function purgeUsage(connection: Connection, options: { dailyRetentionDays: number; dryRun: boolean; now?: Date; retentionDays: number }): Promise<PurgeCounts> {
  const cutoffDay = addDays(darwinDay(options.now ?? new Date()), -options.retentionDays);
  const cutoffUtc = dayStartUtc(cutoffDay);
  if (!cutoffUtc) throw new Error("purgeUsage: no cutoff");
  const viewsEligible = await count(connection, ELIGIBLE_VIEWS, cutoffUtc);
  const dailyCutoffDay = addDays(darwinDay(options.now ?? new Date()), -options.dailyRetentionDays);
  const base = { cutoffDay, dailyCutoffDay, dryRun: options.dryRun, viewsEligible };
  if (options.dryRun) {
    const sessionsEligible = await count(connection, ELIGIBLE_SESSIONS, cutoffUtc);
    const daily = await purgeDaily(connection, dailyCutoffDay, true);
    return { ...base, dailyDeleted: 0, dailyEligible: daily.eligible, sessionsDeleted: 0, sessionsEligible, viewsDeleted: 0 };
  }
  const viewsDeleted = await deleteBatches(
    connection,
    `DELETE FROM dbo.UsageViews WHERE ViewId IN (SELECT TOP (@Batch) v.ViewId ${ELIGIBLE_VIEWS} ORDER BY v.ViewId); SELECT @@ROWCOUNT AS Removed;`,
    cutoffUtc,
  );
  const sessionsEligible = await count(connection, ELIGIBLE_SESSIONS, cutoffUtc);
  const sessionsDeleted = await deleteBatches(
    connection,
    `DELETE FROM dbo.UsageSessions WHERE SessionId IN (SELECT TOP (@Batch) s.SessionId ${ELIGIBLE_SESSIONS} ORDER BY s.SessionId); SELECT @@ROWCOUNT AS Removed;`,
    cutoffUtc,
  );
  const daily = await purgeDaily(connection, dailyCutoffDay, false);
  return { ...base, dailyDeleted: daily.deleted, dailyEligible: daily.eligible, sessionsDeleted, sessionsEligible, viewsDeleted };
}
