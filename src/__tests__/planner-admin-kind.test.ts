/// <reference types="jest" />
import type { Timer } from "@azure/functions";
import type { Connection } from "tedious";

// A0: Planner follows the contractor and money flow. An Admin / Accounts job
// (plan D2) has neither, so with the Planner switch on, none of the job syncs, the
// job-save reconcile or the nightly timer creates, updates or completes a task for
// one. Each case runs the same facts as a facilities job to show the skip is the
// kind and nothing else.

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createServiceConnection: jest.fn(),
  executeQuery: jest.fn(),
}));
jest.mock("../planner", () => ({
  getPlanConfig: jest.fn().mockReturnValue({ bucketId: "bucket", planId: "plan" }),
  graphCompletePlannerTask: jest.fn().mockResolvedValue(undefined),
  graphCreatePlannerTask: jest.fn().mockResolvedValue("task-1"),
  graphGetGroupMembers: jest.fn().mockResolvedValue(["member-1"]),
  graphGetPlannerTask: jest.fn().mockResolvedValue({ etag: "etag" }),
}));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), flush: jest.fn().mockResolvedValue(true) } }));

import { plannerSyncTimer } from "../functions/plannerSyncTimer";
import {
  type AccountsSyncDeps,
  type FacilitiesSyncDeps,
  syncJobActionTriggersStandalone,
  syncJobAwaitingAccounts,
  syncJobAwaitingFacilitiesApproval,
  syncJobDirectorApproval,
  syncJobOnchargePending,
  syncJobStalled,
} from "../jobPlannerSync";

const db = require("../db") as { closeConnection: jest.Mock; createServiceConnection: jest.Mock; executeQuery: jest.Mock };
const planner = require("../planner") as { graphCompletePlannerTask: jest.Mock; graphCreatePlannerTask: jest.Mock; graphGetPlannerTask: jest.Mock };

const connection = {} as Connection;
const accountsDeps: AccountsSyncDeps = { accountsMembers: ["acc-1"], appBaseUrl: "https://floorplan.example", connection };
const facilitiesDeps: FacilitiesSyncDeps = { appBaseUrl: "https://floorplan.example", connection, facilitiesMembers: ["fac-1"] };

const ENV_NAMES = [
  "APP_BASE_URL",
  "PLANNER_ACCOUNTS_GROUP_ID",
  "PLANNER_ACCOUNTS_PLAN_ID",
  "PLANNER_FACILITIES_GROUP_ID",
  "PLANNER_FACILITIES_PLAN_ID",
  "PLANNER_SYNC_ENABLED",
];
let savedEnv: Record<string, string | undefined>;

type Row = Record<string, unknown>;
type Route = [RegExp, Row[]];
function routeSql(routes: Route[]): void {
  db.executeQuery.mockImplementation(async (_connection: unknown, sql: string) => routes.find(([pattern]) => pattern.test(sql))?.[1] ?? []);
}
const sqlText = (): string[] => db.executeQuery.mock.calls.map((call: unknown[]) => String(call[1]));
const plannerWrites = (): string[] => sqlText().filter((sql) => /(INSERT INTO|UPDATE) dbo\.PlannerTasks/.test(sql));

// A job row that qualifies for each of the five triggers when it is a facilities job.
const jobSqlRow = (Kind: string, over: Row = {}): Row => ({
  AssignedToEntraOid: null,
  AwaitingRole: "accounts",
  BuildingName: "9 Cavanagh",
  DirectorNeededCount: 1,
  HasOutgoing: null,
  IsArchived: 0,
  IsOnchargeable: 1,
  IsStalled: 1,
  JobID: 7,
  Kind,
  OnchargeAmount: 250,
  OnchargeNotes: null,
  StalledAt: "2026-10-10T00:00:00.000",
  Status: "Awaiting Approval",
  Title: "Superseded lighting invoice",
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    APP_BASE_URL: "https://floorplan.example",
    PLANNER_ACCOUNTS_GROUP_ID: "group-accounts",
    PLANNER_ACCOUNTS_PLAN_ID: "plan-accounts",
    PLANNER_FACILITIES_GROUP_ID: "group-facilities",
    PLANNER_FACILITIES_PLAN_ID: "plan-facilities",
    PLANNER_SYNC_ENABLED: "true",
  });
  db.createServiceConnection.mockResolvedValue(connection);
  db.executeQuery.mockResolvedValue([]);
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const SYNCS: Array<[string, () => Promise<void>, Row]> = [
  ["syncJobAwaitingAccounts", () => syncJobAwaitingAccounts(7, accountsDeps), { AwaitingRole: "accounts" }],
  ["syncJobAwaitingFacilitiesApproval", () => syncJobAwaitingFacilitiesApproval(7, facilitiesDeps), { AwaitingRole: "facilities" }],
  ["syncJobStalled", () => syncJobStalled(7, facilitiesDeps), { AwaitingRole: "facilities", Status: "Work" }],
  ["syncJobOnchargePending", () => syncJobOnchargePending(7, accountsDeps), { Status: "Work" }],
  ["syncJobDirectorApproval", () => syncJobDirectorApproval(7, accountsDeps), {}],
];

describe("the per-job Planner syncs", () => {
  it.each(SYNCS)("%s creates a task for a facilities job", async (_name, run, over) => {
    routeSql([[/FROM dbo\.Jobs j/, [jobSqlRow("facilities", over)]]]);

    await run();

    expect(planner.graphCreatePlannerTask).toHaveBeenCalledTimes(1);
    expect(plannerWrites()).toHaveLength(1);
  });

  it.each(SYNCS)("%s creates nothing for an Admin / Accounts job with the same facts, and does not even look for a task", async (_name, run, over) => {
    routeSql([[/FROM dbo\.Jobs j/, [jobSqlRow("admin", over)]]]);

    await run();

    expect(planner.graphCreatePlannerTask).not.toHaveBeenCalled();
    expect(plannerWrites()).toEqual([]);
    expect(sqlText().some((sql) => /FROM dbo\.PlannerTasks/.test(sql))).toBe(false);
  });

  it.each(SYNCS)("%s leaves a kind nobody listed alone as well", async (_name, run, over) => {
    routeSql([[/FROM dbo\.Jobs j/, [jobSqlRow("projects", over)]]]);

    await run();

    expect(planner.graphCreatePlannerTask).not.toHaveBeenCalled();
    expect(plannerWrites()).toEqual([]);
  });

  it("completes nothing for an Admin / Accounts job either: an active task stays as it is", async () => {
    const active = [/FROM dbo\.PlannerTasks/, [{ Id: 5, PlannerTaskId: "task-9", Status: "active" }]] as Route;
    // Awaiting facilities, so the awaiting_accounts task would be resolved for a facilities job.
    routeSql([[/FROM dbo\.Jobs j/, [jobSqlRow("facilities", { AwaitingRole: "facilities" })]], active]);
    await syncJobAwaitingAccounts(7, accountsDeps);
    expect(planner.graphCompletePlannerTask).toHaveBeenCalledTimes(1);
    expect(plannerWrites().some((sql) => /Status = 'resolved'/.test(sql))).toBe(true);

    jest.clearAllMocks();
    routeSql([[/FROM dbo\.Jobs j/, [jobSqlRow("admin", { AwaitingRole: "facilities" })]], active]);
    await syncJobAwaitingAccounts(7, accountsDeps);
    expect(planner.graphGetPlannerTask).not.toHaveBeenCalled();
    expect(planner.graphCompletePlannerTask).not.toHaveBeenCalled();
    expect(plannerWrites()).toEqual([]);
  });
});

describe("the job-save reconcile", () => {
  it("opens all five triggers for a facilities job, and none of the five writes anything for an admin job", async () => {
    routeSql([[/FROM dbo\.Jobs j/, [jobSqlRow("facilities")]]]);
    await syncJobActionTriggersStandalone(7);
    expect(planner.graphCreatePlannerTask).toHaveBeenCalled();

    jest.clearAllMocks();
    routeSql([[/FROM dbo\.Jobs j/, [jobSqlRow("admin")]]]);
    await syncJobActionTriggersStandalone(7);
    expect(planner.graphCreatePlannerTask).not.toHaveBeenCalled();
    expect(plannerWrites()).toEqual([]);
  });
});

describe("the nightly timer's job-update tasks", () => {
  const DUE = /FROM Jobs j\s+LEFT JOIN dbo\.Buildings b[\s\S]*ExpectedProgressUpdate IS NOT NULL/;
  const dueRow = (JobID: number, Kind: string): Row => ({
    BuildingName: "9 Cavanagh",
    ExpectedProgressUpdate: "2026-10-10T00:00:00.000",
    JobID,
    Kind,
    Title: `Job ${JobID}`,
  });
  const insertedJobIds = (): unknown[] =>
    db.executeQuery.mock.calls
      .filter((call: unknown[]) => /INSERT INTO dbo\.PlannerTasks/.test(String(call[1])))
      .map((call: unknown[]) => (call[2] as Array<{ name: string; value: unknown }>).find((param) => param.name === "EntityId")?.value);

  it("makes a task for each facilities and maintenance job that is due, and none for an admin job that is due too", async () => {
    routeSql([[DUE, [dueRow(20, "facilities"), dueRow(21, "admin"), dueRow(22, "maintenance")]]]);
    const log = { error: jest.fn(), log: jest.fn(), warn: jest.fn() };

    await plannerSyncTimer({} as Timer, log as never);

    expect(insertedJobIds()).toEqual([20, 22]);
    expect(planner.graphCreatePlannerTask).toHaveBeenCalledTimes(2);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("asks for the kind, so the skip can't be lost from the query", async () => {
    routeSql([[DUE, []]]);

    await plannerSyncTimer({} as Timer, { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as never);

    expect(sqlText().find((sql) => DUE.test(sql))).toMatch(/j\.Kind/);
  });
});
