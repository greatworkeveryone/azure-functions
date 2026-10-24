/// <reference types="jest" />
import { BATCH_SIZE, MAX_BATCHES, purgeUsage } from "./purge";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));
import { executeQuery } from "../db";

const query = jest.mocked(executeQuery);
const conn = {} as never;
const NOW = new Date("2026-10-24T03:00:00Z");
const isDelete = (sql: string) => /^\s*DELETE FROM/.test(sql);

function answer(counts: { sessions: number; views: number }, deletes: number[] = []) {
  const queue = [...deletes];
  query.mockImplementation(async (_c, sql) => {
    const text = String(sql);
    if (isDelete(text)) return [{ Removed: queue.shift() ?? 0 }];
    if (/UsageViews v\s+JOIN/.test(text) && text.includes("COUNT_BIG")) return [{ N: counts.views }];
    return [{ N: counts.sessions }];
  });
}

beforeEach(() => jest.clearAllMocks());

describe("purgeUsage: a dry run", () => {
  it("counts what would go and runs no delete at all", async () => {
    answer({ sessions: 4, views: 9 });
    expect(await purgeUsage(conn, { dryRun: true, now: NOW, retentionDays: 180 })).toEqual({
      cutoffDay: "2026-04-27",
      dryRun: true,
      sessionsDeleted: 0,
      sessionsEligible: 4,
      viewsDeleted: 0,
      viewsEligible: 9,
    });
    expect(query.mock.calls.some((call) => isDelete(String(call[1])))).toBe(false);
  });
});

describe("purgeUsage: selection", () => {
  it("cuts off at the retention window counted in Darwin days, as a UTC instant at Darwin midnight", async () => {
    answer({ sessions: 0, views: 0 });
    await purgeUsage(conn, { dryRun: true, now: NOW, retentionDays: 30 });
    const cutoff = (query.mock.calls[0][2] as { name: string; value: Date }[]).find((p) => p.name === "CutoffUtc")?.value;
    expect(cutoff?.toISOString()).toBe("2026-09-23T14:30:00.000Z");
  });

  it("selects a view only when its person-day is rolled up after the day ended and after the session's last heartbeat", async () => {
    answer({ sessions: 0, views: 0 });
    await purgeUsage(conn, { dryRun: true, now: NOW, retentionDays: 180 });
    const sql = String(query.mock.calls[0][1]);
    expect(sql).toMatch(/v\.EnteredAt < @CutoffUtc/);
    expect(sql).toMatch(/EXISTS \(\s*SELECT 1 FROM dbo\.UsageDaily d/);
    expect(sql).toMatch(/d\.ModuleKey = N'\*'/);
    expect(sql).toMatch(/d\.DeviceClass = dev\.DeviceClass/);
    expect(sql).toMatch(/d\.UserId = s\.UserId/);
    expect(sql).toMatch(/d\.RolledUpAt >= DATEADD\(MINUTE, -570, DATEADD\(DAY, 1, CAST\(d\.Day AS DATETIME2\(3\)\)\)\)/);
    expect(sql).toMatch(/d\.RolledUpAt >= s\.LastHeartbeatAt/);
    expect(sql).not.toMatch(/NOT IN|<>|EXCEPT/i);
  });

  it("selects a session only when it has no views left and its day is rolled up", async () => {
    answer({ sessions: 0, views: 0 });
    await purgeUsage(conn, { dryRun: true, now: NOW, retentionDays: 180 });
    const sql = String(query.mock.calls[1][1]);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM dbo\.UsageViews v WHERE v\.SessionId = s\.SessionId\)/);
    expect(sql).toMatch(/s\.LastHeartbeatAt < @CutoffUtc/);
    expect(sql).toMatch(/FROM dbo\.UsageDaily d/);
  });
});

describe("purgeUsage: a live run", () => {
  it("deletes views then sessions, in batches, and only from the usage tables", async () => {
    answer({ sessions: 3, views: BATCH_SIZE + 10 }, [BATCH_SIZE, 10, 3]);
    const counts = await purgeUsage(conn, { dryRun: false, now: NOW, retentionDays: 180 });
    expect(counts).toMatchObject({ dryRun: false, sessionsDeleted: 3, viewsDeleted: BATCH_SIZE + 10 });
    const deletes = query.mock.calls.map((call) => String(call[1])).filter(isDelete);
    expect(deletes).toHaveLength(3);
    expect(deletes[0]).toMatch(/^DELETE FROM dbo\.UsageViews WHERE ViewId IN \(SELECT TOP \(@Batch\) v\.ViewId/);
    expect(deletes[2]).toMatch(/^DELETE FROM dbo\.UsageSessions WHERE SessionId IN \(SELECT TOP \(@Batch\) s\.SessionId/);
    for (const sql of deletes) expect(sql).not.toMatch(/UsageDaily WHERE|UsageDevices WHERE|FROM dbo\.UsageDaily\s*;|DELETE FROM dbo\.UsageDaily|DELETE FROM dbo\.UsageDevices/);
  });

  it("stops at its per-run cap when there is always more to delete", async () => {
    query.mockImplementation(async (_c, sql) => (isDelete(String(sql)) ? [{ Removed: BATCH_SIZE }] : [{ N: 1 }]));
    const counts = await purgeUsage(conn, { dryRun: false, now: NOW, retentionDays: 180 });
    expect(counts.viewsDeleted).toBe(BATCH_SIZE * MAX_BATCHES);
    expect(query.mock.calls.filter((call) => isDelete(String(call[1])))).toHaveLength(MAX_BATCHES * 2);
  });

  it("deletes nothing when nothing is eligible", async () => {
    answer({ sessions: 0, views: 0 });
    const counts = await purgeUsage(conn, { dryRun: false, now: NOW, retentionDays: 180 });
    expect(counts).toMatchObject({ sessionsDeleted: 0, viewsDeleted: 0 });
  });
});
