/// <reference types="jest" />
import { storeUsageBatch, userIdForOid } from "./ingest";
import type { UsageBatch } from "./validate";

jest.mock("../db", () => ({
  beginTransaction: jest.fn(async () => undefined),
  commitTransaction: jest.fn(async () => undefined),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn(async () => undefined),
}));
import { beginTransaction, commitTransaction, executeQuery, rollbackTransaction } from "../db";

const query = jest.mocked(executeQuery);
const conn = {} as never;
const batch: UsageBatch = {
  device: { browser: "Chrome", class: "tablet", id: "d_abcdefghijklmnop1", osFamily: "Android", persistent: true },
  sessionId: "x_abcdefghijklmnop1",
  views: [
    { activeSeconds: 40, continued: false, enteredAt: new Date("2026-10-24T01:00:00Z"), module: "inspections", route: "/inspections/[id]", seq: 1 },
    { activeSeconds: 20, continued: true, enteredAt: new Date("2026-10-24T01:05:00Z"), module: "jobs", route: "/jobs", seq: 2 },
  ],
};
const sqls = () => query.mock.calls.map((call) => String(call[1]));
const param = (callIndex: number, name: string) => (query.mock.calls[callIndex][2] as { name: string; value: unknown }[]).find((p) => p.name === name)?.value;

beforeEach(() => {
  jest.clearAllMocks();
  query.mockResolvedValue([]);
});

describe("userIdForOid", () => {
  it("finds the active person for the token's oid with a bound parameter", async () => {
    query.mockResolvedValueOnce([{ UserID: 12 }]);
    expect(await userIdForOid(conn, "oid-9")).toBe(12);
    expect(String(query.mock.calls[0][1])).toMatch(/IsActive = 1/);
    expect(param(0, "Oid")).toBe("oid-9");
  });

  it("returns null for nobody", async () => {
    expect(await userIdForOid(conn, "oid-0")).toBeNull();
  });
});

describe("storeUsageBatch: a new session", () => {
  it("records the device, a session owned by the given person, and one row per view, in one transaction", async () => {
    expect(await storeUsageBatch(conn, 7, batch, new Date("2026-10-24T01:00:00Z"))).toBe("stored");
    expect(beginTransaction).toHaveBeenCalledTimes(1);
    expect(commitTransaction).toHaveBeenCalledTimes(1);
    expect(sqls()[0]).toMatch(/MERGE dbo\.UsageDevices/);
    const insert = sqls().findIndex((sql) => /INSERT INTO dbo\.UsageSessions/.test(sql));
    expect(insert).toBeGreaterThan(0);
    expect(param(insert, "UserId")).toBe(7);
    expect(param(insert, "Delta")).toBe(60);
    expect(sqls().filter((sql) => /MERGE dbo\.UsageViews/.test(sql))).toHaveLength(2);
    const merges = query.mock.calls.map((_c, index) => index).filter((index) => /MERGE dbo\.UsageViews/.test(sqls()[index]));
    expect(param(merges[0], "Module")).toBe("inspections");
    expect(param(merges[1], "Continued")).toBe(true);
  });

  it("writes only through bound parameters: no value is joined into SQL text", async () => {
    await storeUsageBatch(conn, 7, batch, new Date());
    for (const sql of sqls()) expect(sql).not.toMatch(/inspections|d_abcdefghijklmnop1|x_abcdefghijklmnop1/);
  });
});

describe("storeUsageBatch: an existing session", () => {
  it("adds to the running total, capped, for the same person", async () => {
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ ActiveSeconds: 0, LastHeartbeatAt: new Date(), StartedAt: new Date(Date.now() - 3600_000), UserId: 7 }]);
    await storeUsageBatch(conn, 7, batch, new Date());
    const update = sqls().findIndex((sql) => /UPDATE dbo\.UsageSessions/.test(sql));
    expect(sqls()[update]).toMatch(/CASE WHEN ActiveSeconds \+ @Delta > @Cap/);
    expect(sqls()[update]).toMatch(/AND UserId = @UserId/);
    expect(param(update, "Cap")).toBe(86400);
    expect(commitTransaction).toHaveBeenCalled();
  });

  it("drops a batch that names someone else's session, writes no view and rolls back", async () => {
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ UserId: 8 }]);
    expect(await storeUsageBatch(conn, 7, batch, new Date())).toBe("foreign_session");
    expect(sqls().some((sql) => /UsageViews|UPDATE dbo\.UsageSessions|INSERT INTO dbo\.UsageSessions/.test(sql))).toBe(false);
    expect(rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(commitTransaction).not.toHaveBeenCalled();
  });
});

describe("storeUsageBatch: active time cannot be forged", () => {
  const NOW = new Date("2026-10-24T01:10:00Z");
  const heavy: UsageBatch = { ...batch, views: [{ ...batch.views[0], activeSeconds: 900, enteredAt: new Date("2026-10-24T01:09:00Z") }, { ...batch.views[1], activeSeconds: 900, enteredAt: new Date("2026-10-24T01:09:30Z") }] };
  const delta = (callIndex: number) => param(callIndex, "Delta");
  const viewSeconds = () => query.mock.calls.filter((call) => /MERGE dbo\.UsageViews/.test(String(call[1]))).map((call) => (call[2] as { name: string; value: unknown }[]).find((p) => p.name === "Seconds")?.value);

  it("adds no more to an existing session than the time since its last heartbeat plus a minute", async () => {
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ ActiveSeconds: 100, LastHeartbeatAt: new Date("2026-10-24T01:09:15Z"), StartedAt: new Date("2026-10-24T01:00:00Z"), UserId: 7 }]);
    await storeUsageBatch(conn, 7, heavy, new Date("2026-10-24T01:09:00Z"), NOW);
    const update = query.mock.calls.findIndex((call) => /UPDATE dbo\.UsageSessions/.test(String(call[1])));
    expect(delta(update)).toBeLessThanOrEqual(45 + 60);
    expect(viewSeconds().reduce((sum: number, value) => sum + Number(value), 0)).toBeLessThanOrEqual(105);
  });

  it("limits a new session by the time since it started, plus a minute", async () => {
    await storeUsageBatch(conn, 7, heavy, new Date("2026-10-24T01:09:00Z"), NOW);
    const insert = query.mock.calls.findIndex((call) => /INSERT INTO dbo\.UsageSessions/.test(String(call[1])));
    expect(delta(insert)).toBeLessThanOrEqual(60 + 60);
  });

  it("lets a normal heartbeat through whole", async () => {
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ ActiveSeconds: 100, LastHeartbeatAt: new Date("2026-10-24T01:09:15Z"), StartedAt: new Date("2026-10-24T01:00:00Z"), UserId: 7 }]);
    const normal: UsageBatch = { ...batch, views: [{ ...batch.views[0], activeSeconds: 45, enteredAt: new Date("2026-10-24T01:05:00Z") }] };
    await storeUsageBatch(conn, 7, normal, new Date("2026-10-24T01:05:00Z"), NOW);
    expect(viewSeconds()).toEqual([45]);
  });

  it("holds a person to 24 hours a day across all their sessions, not per session id", async () => {
    query.mockImplementation(async (_c, sql) => (/SUM\(v\.ActiveSeconds\)/.test(String(sql)) ? [{ Used: 86_380 }] : []));
    const fresh: UsageBatch = { ...batch, sessionId: "x_anotherbrandnewsession", views: [{ ...batch.views[0], activeSeconds: 100, enteredAt: new Date("2026-10-24T01:09:00Z") }] };
    await storeUsageBatch(conn, 7, fresh, new Date("2026-10-23T23:00:00Z"), NOW);
    expect(viewSeconds()).toEqual([20]);
    const sum = query.mock.calls.find((call) => /SUM\(v\.ActiveSeconds\)/.test(String(call[1])));
    expect(String(sum?.[1])).toMatch(/s\.UserId = @UserId/);
  });
});

describe("storeUsageBatch: failure", () => {
  it("rolls back and rethrows", async () => {
    query.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("db down"));
    await expect(storeUsageBatch(conn, 7, batch, new Date())).rejects.toThrow("db down");
    expect(rollbackTransaction).toHaveBeenCalled();
    expect(commitTransaction).not.toHaveBeenCalled();
  });
});
