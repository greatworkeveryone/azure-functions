/// <reference types="jest" />
import type { Connection } from "tedious";
import { escalationChannelColumnExists, resetEscalationChannelColumnProbe } from "./escalationChannelColumn";
import { recordNotification } from "./store";

jest.mock("../db", () => {
  const actual = jest.requireActual("../db");
  return { ...actual, executeQuery: jest.fn() };
});
const db = require("../db") as { executeQuery: jest.Mock };
const conn = {} as Connection;
const OUTCOME = { attemptedAt: new Date("2026-10-13T01:00:00Z"), error: null, notifiedAt: null, state: "sent" as const };
const sqlOf = (call: number): string => db.executeQuery.mock.calls[call][1] as string;
const paramNames = (call: number): string[] => (db.executeQuery.mock.calls[call][2] as { name: string }[]).map((p) => p.name);

beforeEach(() => {
  jest.resetAllMocks();
  resetEscalationChannelColumnProbe();
});

describe("migration 156 probe", () => {
  it("is false until the column exists, and re-probes each time", async () => {
    db.executeQuery.mockResolvedValue([{ Len: null }]);
    expect(await escalationChannelColumnExists(conn)).toBe(false);
    expect(await escalationChannelColumnExists(conn)).toBe(false);
    expect(db.executeQuery).toHaveBeenCalledTimes(2);
  });

  it("remembers a positive answer", async () => {
    db.executeQuery.mockResolvedValue([{ Len: 32 }]);
    expect(await escalationChannelColumnExists(conn)).toBe(true);
    expect(await escalationChannelColumnExists(conn)).toBe(true);
    expect(db.executeQuery).toHaveBeenCalledTimes(1);
  });
});

describe("recordNotification and the channel column", () => {
  it("leaves the column out before 156 is applied, so the bookkeeping still writes", async () => {
    db.executeQuery.mockResolvedValueOnce([{ Len: null }]).mockResolvedValueOnce([]);
    await recordNotification(conn, 42, { ...OUTCOME, channel: "teams" }, 1);
    expect(sqlOf(1)).not.toContain("NotificationChannel");
    expect(paramNames(1)).not.toContain("Channel");
  });

  it("writes the channel once the column exists", async () => {
    db.executeQuery.mockResolvedValueOnce([{ Len: 32 }]).mockResolvedValueOnce([]);
    await recordNotification(conn, 42, { ...OUTCOME, channel: "teams" }, 1);
    expect(sqlOf(1)).toContain("NotificationChannel = @Channel");
    expect(paramNames(1)).toContain("Channel");
  });

  it("does not probe when no channel is given", async () => {
    db.executeQuery.mockResolvedValue([]);
    await recordNotification(conn, 42, OUTCOME, 1);
    expect(db.executeQuery).toHaveBeenCalledTimes(1);
    expect(sqlOf(0)).not.toContain("NotificationChannel");
  });
});
