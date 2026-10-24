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
    expect(sqls()[2]).toMatch(/INSERT INTO dbo\.UsageSessions/);
    expect(param(2, "UserId")).toBe(7);
    expect(param(2, "Delta")).toBe(60);
    expect(sqls().filter((sql) => /MERGE dbo\.UsageViews/.test(sql))).toHaveLength(2);
    expect(param(3, "Module")).toBe("inspections");
    expect(param(4, "Continued")).toBe(true);
  });

  it("writes only through bound parameters: no value is joined into SQL text", async () => {
    await storeUsageBatch(conn, 7, batch, new Date());
    for (const sql of sqls()) expect(sql).not.toMatch(/inspections|d_abcdefghijklmnop1|x_abcdefghijklmnop1/);
  });
});

describe("storeUsageBatch: an existing session", () => {
  it("adds to the running total, capped, for the same person", async () => {
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ UserId: 7 }]);
    await storeUsageBatch(conn, 7, batch, new Date());
    expect(sqls()[2]).toMatch(/UPDATE dbo\.UsageSessions/);
    expect(sqls()[2]).toMatch(/CASE WHEN ActiveSeconds \+ @Delta > @Cap/);
    expect(sqls()[2]).toMatch(/AND UserId = @UserId/);
    expect(param(2, "Cap")).toBe(86400);
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

describe("storeUsageBatch: failure", () => {
  it("rolls back and rethrows", async () => {
    query.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("db down"));
    await expect(storeUsageBatch(conn, 7, batch, new Date())).rejects.toThrow("db down");
    expect(rollbackTransaction).toHaveBeenCalled();
    expect(commitTransaction).not.toHaveBeenCalled();
  });
});
