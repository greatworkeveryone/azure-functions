/// <reference types="jest" />
// D9: a test record never reaches Planner. graphCreatePlannerTask refuses it
// before asking for a token; reconcileTask records the refusal and moves on;
// the timer leaves test tenancies and jobs out of what it reads.
import { readFileSync } from "node:fs";
import { join } from "node:path";

jest.mock("../db", () => ({ executeQuery: jest.fn().mockResolvedValue([]) }));
jest.mock("../graph", () => ({ ...jest.requireActual("../graph"), getGraphToken: jest.fn().mockResolvedValue("tok") }));

import { graphCreatePlannerTask } from "../planner";
import { reconcileTask } from "../jobPlannerSync";
import { NOT_A_RECORD, TestDataEgressError } from "../test-data";

const db = require("../db") as { executeQuery: jest.Mock };
const graph = require("../graph") as { getGraphToken: jest.Mock };

const PARAMS = { assigneeIds: [], bucketId: "b", description: "d", dueDate: "2026-10-20", planId: "p", title: "t" };
const fetchMock = jest.fn();

beforeAll(() => {
  process.env.PLANNER_SYNC_ENABLED = "true";
  process.env.PLANNER_ACCOUNTS_PLAN_ID = "p";
  process.env.PLANNER_ACCOUNTS_BUCKET_AWAITING_ID = "b";
});

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockResolvedValue({ headers: { get: () => "etag" }, json: async () => ({ id: "task-1" }), ok: true, text: async () => "" });
});

describe("graphCreatePlannerTask", () => {
  it("refuses a test record before asking for a token or calling Graph", async () => {
    await expect(graphCreatePlannerTask({ ...PARAMS, egress: { isTest: true } })).rejects.toBeInstanceOf(TestDataEgressError);
    expect(graph.getGraphToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates a real record's task", async () => {
    await expect(graphCreatePlannerTask({ ...PARAMS, egress: { isTest: false } })).resolves.toBe("task-1");
    await expect(graphCreatePlannerTask({ ...PARAMS, egress: NOT_A_RECORD })).resolves.toBe("task-1");
  });
});

describe("reconcileTask", () => {
  const base = {
    assigneeIds: [],
    connection: {} as never,
    description: "d",
    dueDate: "2026-10-20",
    entityId: 7,
    entityType: "job" as const,
    planType: "accounts" as const,
    shouldHaveTask: true,
    title: "t",
    triggerType: "awaiting_accounts" as const,
  };

  it("creates no task and no PlannerTasks row for a test job, and logs why", async () => {
    const log = jest.fn();
    await reconcileTask({ ...base, isTest: true, log });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.executeQuery.mock.calls.some(([, sql]: [unknown, string]) => /INSERT INTO dbo\.PlannerTasks/.test(sql))).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Not sent: test record"));
  });

  it("creates a real job's task", async () => {
    await reconcileTask({ ...base, isTest: false });
    expect(fetchMock).toHaveBeenCalled();
    expect(db.executeQuery.mock.calls.some(([, sql]: [unknown, string]) => /INSERT INTO dbo\.PlannerTasks/.test(sql))).toBe(true);
  });
});

describe("what the planner reads", () => {
  const timer = readFileSync(join(__dirname, "..", "functions", "plannerSyncTimer.ts"), "utf8");
  const sync = readFileSync(join(__dirname, "..", "jobPlannerSync.ts"), "utf8");
  const keys = readFileSync(join(__dirname, "..", "keyPlannerSync.ts"), "utf8");

  it("the timer leaves test tenancies and test jobs out of every selection", () => {
    expect(timer).toMatch(/AND t\.ArchivedAt IS NULL\s+AND t\.IsTest = 0/);
    expect(timer).toMatch(/WHERE j\.IsArchived = 0\s+AND j\.IsTest = 0\s+AND j\.Status <> 'Done'\s+AND j\.ExpectedProgressUpdate IS NOT NULL/);
    expect(timer.match(/WHERE \(\s*j\.IsTest = 0 AND /g)).toHaveLength(5);
  });

  it("every create passes what the task is about", () => {
    const creates = (timer.match(/graphCreatePlannerTask\(\{/g) ?? []).length;
    expect(creates).toBeGreaterThan(0);
    expect((timer.match(/egress: \{ isTest: (tenant|job)\.isTest \}/g) ?? []).length).toBe(creates);
  });

  it("each sync reads the record's flag and hands it to reconcileTask", () => {
    expect((sync.match(/SELECT j\.JobID, j\.Title, j\.IsTest,/g) ?? []).length).toBe(5);
    expect((sync.match(/isTest: Boolean\(r\.IsTest\)/g) ?? []).length).toBe(5);
    expect(keys).toMatch(/SELECT k\.Id, k\.KeyNumber, k\.IsTest,/);
    expect(keys).toMatch(/isTest: row\.IsTest === true \|\| row\.IsTest === 1/);
  });
});
