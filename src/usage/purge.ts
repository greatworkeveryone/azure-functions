import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../db";
import { addDays, dayStartUtc, darwinDay } from "./days";

// The purge (PLAN §14, database-safety rule 2). It deletes only RAW usage rows older than the
// retention window, chosen positively: a view goes only when its person's roll-up for its Darwin day
// exists, was made after the day ended and after the session's last heartbeat (so nothing is lost
// that the roll-up has not counted). A session goes only when it is past the window, has no views
// left and its Darwin day has been rolled up after it ended. Devices and the daily roll-ups are
// never deleted. Whether anything is deleted is the caller's choice (USAGE_PURGE_ENABLED, with
// USAGE_PURGE_DRY_RUN to count only); a run deletes at most MAX_PER_RUN rows of each kind.

export const BATCH_SIZE = 5000;
export const MAX_BATCHES = 40;
export const MAX_PER_RUN = BATCH_SIZE * MAX_BATCHES;

export interface PurgeCounts {
  cutoffDay: string;
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
      WHERE d.Day = CAST(DATEADD(MINUTE, 570, s.StartedAt) AS DATE) AND d.RolledUpAt >= DATEADD(MINUTE, -570, DATEADD(DAY, 1, CAST(d.Day AS DATETIME2(3)))))`;

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

export async function purgeUsage(connection: Connection, options: { dryRun: boolean; now?: Date; retentionDays: number }): Promise<PurgeCounts> {
  const cutoffDay = addDays(darwinDay(options.now ?? new Date()), -options.retentionDays);
  const cutoffUtc = dayStartUtc(cutoffDay);
  if (!cutoffUtc) throw new Error("purgeUsage: no cutoff");
  const viewsEligible = await count(connection, ELIGIBLE_VIEWS, cutoffUtc);
  const base = { cutoffDay, dryRun: options.dryRun, viewsEligible };
  if (options.dryRun) {
    return { ...base, sessionsDeleted: 0, sessionsEligible: await count(connection, ELIGIBLE_SESSIONS, cutoffUtc), viewsDeleted: 0 };
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
  return { ...base, sessionsDeleted, sessionsEligible, viewsDeleted };
}
