/// <reference types="jest" />
import { recentRollupRange, rollUpDays, ROLLUP_RECENT_DAYS } from "./rollup";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));
import { executeQuery } from "../db";

const query = jest.mocked(executeQuery);
const conn = {} as never;

beforeEach(() => {
  jest.clearAllMocks();
  query.mockResolvedValue([]);
});

describe("rollUpDays", () => {
  it("rolls up the Darwin days asked for, as UTC instants at Darwin midnight, and counts new and refreshed rows", async () => {
    query.mockResolvedValueOnce([{ Action: "INSERT" }, { Action: "INSERT" }, { Action: "UPDATE" }]);
    expect(await rollUpDays(conn, "2026-10-20", "2026-10-21")).toEqual({ days: 2, inserted: 2, updated: 1 });
    const params = query.mock.calls[0][2] as { name: string; value: Date }[];
    expect(params.find((p) => p.name === "FromUtc")?.value.toISOString()).toBe("2026-10-19T14:30:00.000Z");
    expect(params.find((p) => p.name === "ToUtc")?.value.toISOString()).toBe("2026-10-21T14:30:00.000Z");
  });

  it("writes the day's totals as a * row and one row per module, and never makes a figure smaller", async () => {
    await rollUpDays(conn, "2026-10-20", "2026-10-20");
    const sql = String(query.mock.calls[0][1]);
    expect(sql).toMatch(/UNION ALL/);
    expect(sql).toMatch(/N'\*'/);
    expect(sql).toMatch(/COUNT\(DISTINCT SessionId\)/);
    for (const column of ["Sessions", "Views", "ActiveSeconds"]) expect(sql).toMatch(new RegExp(`${column} = CASE WHEN s\\.${column} > t\\.${column} THEN s\\.${column} ELSE t\\.${column} END`));
    expect(sql).not.toMatch(/WHEN NOT MATCHED BY SOURCE/);
    expect(sql).not.toMatch(/DELETE|TRUNCATE|DROP/i);
  });

  it("counts a continuation segment's seconds but not as another view", async () => {
    await rollUpDays(conn, "2026-10-20", "2026-10-20");
    expect(String(query.mock.calls[0][1])).toMatch(/SUM\(CASE WHEN IsContinuation = 0 THEN 1 ELSE 0 END\)/);
  });

  it("refuses dates that are not real, are out of order, or span more than a year", async () => {
    await expect(rollUpDays(conn, "2026-02-30", "2026-03-01")).rejects.toThrow();
    await expect(rollUpDays(conn, "2026-10-21", "2026-10-20")).rejects.toThrow();
    await expect(rollUpDays(conn, "2025-01-01", "2026-10-20")).rejects.toThrow(/at most/);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("recentRollupRange", () => {
  it("is the last three Darwin days, today included", () => {
    expect(ROLLUP_RECENT_DAYS).toBe(3);
    expect(recentRollupRange(new Date("2026-10-24T03:00:00Z"))).toEqual({ from: "2026-10-22", to: "2026-10-24" });
    expect(recentRollupRange(new Date("2026-10-23T15:00:00Z"))).toEqual({ from: "2026-10-22", to: "2026-10-24" });
  });
});
