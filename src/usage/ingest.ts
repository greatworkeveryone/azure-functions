import { TYPES, type Connection } from "tedious";
import { beginTransaction, commitTransaction, executeQuery, rollbackTransaction } from "../db";
import { allowanceSince, limitPerDay, scaleToAllowance, sessionAllowance } from "./clamp";
import { darwinDay, dayEndUtc, dayStartUtc } from "./days";
import type { UsageBatch, UsageViewInput } from "./validate";

// Writing one batch (PLAN §14). The person is the caller's own AppUsers row, found from the verified
// token's oid. A session belongs to the person who started it: a batch that names someone else's
// session is dropped, so nobody can add time to another person's day. Heartbeats add to a running
// total (one row per page segment, not one per beat). What may be added is held to the server's clock: no more
// than the time since the session's last heartbeat plus a minute, and no more than 24 hours a day for the person
// across every session (clamp.ts), so a client cannot inflate a figure by sending big numbers or new session ids.

const SEGMENT_SECONDS_CAP = 3600;
const SESSION_SECONDS_CAP = 86400;

export async function userIdForOid(connection: Connection, oid: string): Promise<number | null> {
  const rows = await executeQuery(connection, `SELECT TOP 1 UserID FROM dbo.AppUsers WHERE EntraOid = @Oid AND IsActive = 1`, [
    { name: "Oid", type: TYPES.NVarChar, value: oid },
  ]);
  return rows.length > 0 ? Number(rows[0].UserID) : null;
}

export type StoreOutcome = "foreign_session" | "stored";

/** What this person already has on each Darwin day the views fall on, from all their sessions. */
async function usedPerDay(connection: Connection, userId: number, views: readonly UsageViewInput[]): Promise<Map<string, number>> {
  const used = new Map<string, number>();
  for (const day of new Set(views.map((item) => darwinDay(item.enteredAt)))) {
    const from = dayStartUtc(day);
    const to = dayEndUtc(day);
    if (!from || !to) continue;
    const rows = await executeQuery(
      connection,
      `SELECT COALESCE(SUM(v.ActiveSeconds), 0) AS Used FROM dbo.UsageViews v JOIN dbo.UsageSessions s ON s.SessionId = v.SessionId
        WHERE s.UserId = @UserId AND v.EnteredAt >= @FromUtc AND v.EnteredAt < @ToUtc`,
      [
        { name: "UserId", type: TYPES.Int, value: userId },
        { name: "FromUtc", type: TYPES.DateTime2, value: from },
        { name: "ToUtc", type: TYPES.DateTime2, value: to },
      ],
    );
    used.set(day, Number(rows[0]?.Used ?? 0));
  }
  return used;
}

export async function storeUsageBatch(connection: Connection, userId: number, batch: UsageBatch, startedAt: Date, now: Date = new Date()): Promise<StoreOutcome> {
  await beginTransaction(connection);
  try {
    await executeQuery(
      connection,
      `MERGE dbo.UsageDevices WITH (HOLDLOCK) AS t
       USING (SELECT @DeviceId AS DeviceId) AS s ON t.DeviceId = s.DeviceId
       WHEN MATCHED THEN UPDATE SET LastSeenAt = SYSUTCDATETIME(), DeviceClass = @Class, BrowserFamily = @Browser, OsFamily = @Os
       WHEN NOT MATCHED THEN INSERT (DeviceId, DeviceClass, BrowserFamily, OsFamily, IsPersistent) VALUES (@DeviceId, @Class, @Browser, @Os, @Persistent);`,
      [
        { name: "DeviceId", type: TYPES.NVarChar, value: batch.device.id },
        { name: "Class", type: TYPES.VarChar, value: batch.device.class },
        { name: "Browser", type: TYPES.NVarChar, value: batch.device.browser },
        { name: "Os", type: TYPES.NVarChar, value: batch.device.osFamily },
        { name: "Persistent", type: TYPES.Bit, value: batch.device.persistent },
      ],
    );

    const existing = await executeQuery(connection, `SELECT UserId, StartedAt, LastHeartbeatAt, ActiveSeconds FROM dbo.UsageSessions WITH (UPDLOCK, HOLDLOCK) WHERE SessionId = @SessionId`, [
      { name: "SessionId", type: TYPES.NVarChar, value: batch.sessionId },
    ]);
    if (existing.length > 0 && Number(existing[0].UserId) !== userId) {
      await rollbackTransaction(connection);
      return "foreign_session";
    }
    const [known] = existing;
    const allowance = known
      ? sessionAllowance({ activeSeconds: Number(known.ActiveSeconds), lastHeartbeatAt: known.LastHeartbeatAt as Date, startedAt: known.StartedAt as Date }, now)
      : allowanceSince(startedAt, now);
    const allowed = limitPerDay(scaleToAllowance(batch.views, allowance), await usedPerDay(connection, userId, batch.views));
    const delta = allowed.reduce((sum, item) => sum + item.activeSeconds, 0);

    if (existing.length === 0) {
      await executeQuery(
        connection,
        `INSERT INTO dbo.UsageSessions (SessionId, UserId, DeviceId, StartedAt, ActiveSeconds) VALUES (@SessionId, @UserId, @DeviceId, @StartedAt, @Delta)`,
        [
          { name: "SessionId", type: TYPES.NVarChar, value: batch.sessionId },
          { name: "UserId", type: TYPES.Int, value: userId },
          { name: "DeviceId", type: TYPES.NVarChar, value: batch.device.id },
          { name: "StartedAt", type: TYPES.DateTime2, value: startedAt },
          { name: "Delta", type: TYPES.Int, value: delta },
        ],
      );
    } else {
      await executeQuery(
        connection,
        `UPDATE dbo.UsageSessions
            SET LastHeartbeatAt = SYSUTCDATETIME(),
                ActiveSeconds = CASE WHEN ActiveSeconds + @Delta > @Cap THEN @Cap ELSE ActiveSeconds + @Delta END
          WHERE SessionId = @SessionId AND UserId = @UserId`,
        [
          { name: "SessionId", type: TYPES.NVarChar, value: batch.sessionId },
          { name: "UserId", type: TYPES.Int, value: userId },
          { name: "Delta", type: TYPES.Int, value: delta },
          { name: "Cap", type: TYPES.Int, value: SESSION_SECONDS_CAP },
        ],
      );
    }

    for (const view of allowed) {
      await executeQuery(
        connection,
        `MERGE dbo.UsageViews WITH (HOLDLOCK) AS t
         USING (SELECT @SessionId AS SessionId, @Seq AS ViewSeq) AS s ON t.SessionId = s.SessionId AND t.ViewSeq = s.ViewSeq
         WHEN MATCHED THEN UPDATE SET ActiveSeconds = CASE WHEN t.ActiveSeconds + @Seconds > @Cap THEN @Cap ELSE t.ActiveSeconds + @Seconds END
         WHEN NOT MATCHED THEN INSERT (SessionId, ViewSeq, ModuleKey, RoutePattern, EnteredAt, ActiveSeconds, IsContinuation)
           VALUES (@SessionId, @Seq, @Module, @Route, @EnteredAt, @Seconds, @Continued);`,
        [
          { name: "SessionId", type: TYPES.NVarChar, value: batch.sessionId },
          { name: "Seq", type: TYPES.Int, value: view.seq },
          { name: "Module", type: TYPES.NVarChar, value: view.module },
          { name: "Route", type: TYPES.NVarChar, value: view.route },
          { name: "EnteredAt", type: TYPES.DateTime2, value: view.enteredAt },
          { name: "Seconds", type: TYPES.Int, value: view.activeSeconds },
          { name: "Continued", type: TYPES.Bit, value: view.continued },
          { name: "Cap", type: TYPES.Int, value: SEGMENT_SECONDS_CAP },
        ],
      );
    }
    await commitTransaction(connection);
    return "stored";
  } catch (error) {
    await rollbackTransaction(connection).catch(() => undefined);
    throw error;
  }
}
