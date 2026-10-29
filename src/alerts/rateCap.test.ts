/// <reference types="jest" />
import type { Connection } from "tedious";
import { claimWorkflowsSlot, CLAIM_SLOT_SQL, resetAlertSendLogProbe, WORKFLOWS_CAP, WORKFLOWS_WINDOW_MINUTES } from "./rateCap";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));
const db = require("../db") as { executeQuery: jest.Mock };
const conn = {} as Connection;

const probeThen = (...claims: Array<number | Error>) => {
  db.executeQuery.mockImplementation(async (_c: Connection, sql: string) => {
    if (sql.includes("OBJECT_ID")) return [{ Id: 123 }];
    const next = claims.shift();
    if (next instanceof Error) throw next;
    return [{ Claimed: next ?? 0 }];
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  resetAlertSendLogProbe();
});

describe("claimWorkflowsSlot", () => {
  it("under the cap: claims and is allowed, with parameters not text", async () => {
    probeThen(1);
    await expect(claimWorkflowsSlot(conn)).resolves.toBe(true);
    const claim = db.executeQuery.mock.calls.find((call: unknown[]) => call[1] === CLAIM_SLOT_SQL);
    expect(claim[2]).toEqual([
      expect.objectContaining({ name: "Channel", value: "workflows" }),
      expect.objectContaining({ name: "WindowMinutes", value: WORKFLOWS_WINDOW_MINUTES }),
      expect.objectContaining({ name: "Cap", value: WORKFLOWS_CAP }),
    ]);
    expect(WORKFLOWS_CAP).toBe(20);
    expect(WORKFLOWS_WINDOW_MINUTES).toBe(5);
  });

  it("at or over the cap the insert claims nothing, so email instead", async () => {
    probeThen(0);
    await expect(claimWorkflowsSlot(conn)).resolves.toBe(false);
  });

  it("the claim is one atomic insert-where-count-below-cap", () => {
    expect(CLAIM_SLOT_SQL).toMatch(/INSERT INTO dbo\.AlertSendLog[\s\S]*WHERE \(SELECT COUNT\(\*\)[\s\S]*UPDLOCK, HOLDLOCK[\s\S]*< @Cap/);
  });

  it("migration absent: no slot, and no claim attempted; picked up once applied without a restart", async () => {
    db.executeQuery.mockResolvedValue([{ Id: null }]);
    await expect(claimWorkflowsSlot(conn)).resolves.toBe(false);
    expect(db.executeQuery).toHaveBeenCalledTimes(1);
    probeThen(1);
    await expect(claimWorkflowsSlot(conn)).resolves.toBe(true);
  });

  it("remembers a positive probe", async () => {
    probeThen(1, 1);
    await claimWorkflowsSlot(conn);
    await claimWorkflowsSlot(conn);
    expect(db.executeQuery.mock.calls.filter((call: unknown[]) => String(call[1]).includes("OBJECT_ID"))).toHaveLength(1);
  });

  it("a database error is no slot, never a throw", async () => {
    probeThen(new Error("deadlock"));
    await expect(claimWorkflowsSlot(conn)).resolves.toBe(false);
  });
});
