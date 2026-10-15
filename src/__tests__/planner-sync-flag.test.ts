/// <reference types="jest" />
import type { HttpRequest, InvocationContext, Timer } from "@azure/functions";
import type { Connection } from "tedious";

// Planner is being retired (PLAN D21, Q16). Production keeps APP_BASE_URL unset
// because setting it used to switch Planner task creation back on through the
// job-save reconcile. APP_BASE_URL is now only for links, and every path that
// creates, updates or completes a Planner task needs PLANNER_SYNC_ENABLED=true.

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createServiceConnection: jest.fn(),
  executeQuery: jest.fn(),
}));
jest.mock("../graph", () => ({ getGraphToken: jest.fn(), graphSendMail: jest.fn() }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), flush: jest.fn().mockResolvedValue(true) } }));
jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    extractToken: jest.fn(),
    requireRole: jest.fn(),
    unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
  };
});
jest.mock("../escalation/store", () => ({
  listActiveUsers: jest.fn(),
  recordNotification: jest.fn().mockResolvedValue(undefined),
}));

import { plannerSyncTimer } from "../functions/plannerSyncTimer";
import "../functions/triggerPlannerSync";
import {
  type AccountsSyncDeps,
  type FacilitiesSyncDeps,
  reconcileTask,
  syncJobActionTriggersStandalone,
  syncJobAwaitingAccounts,
  syncJobAwaitingFacilitiesApproval,
  syncJobDirectorApproval,
  syncJobOnchargePending,
  syncJobStalled,
} from "../jobPlannerSync";
import { syncKeyLostReported, syncKeyLostReportedStandalone } from "../keyPlannerSync";
import {
  graphCompletePlannerTask,
  graphCreatePlannerTask,
  graphGetGroupMembers,
  graphGetPlannerTask,
  resolveActivePlannerTasks,
} from "../planner";
import { _resetPlannerSyncLogForTests, PLANNER_SYNC_DISABLED_MESSAGE } from "../plannerFlag";
import { absoluteLink, appBaseUrl, missingNotificationConfig } from "../escalation/config";
import { notifyTargets } from "../escalation/notifier";
import { SYSTEM_SUBJECTS, systemAdapter } from "../escalation/adapters/system";
import type { DirectoryUser, EscalationRow } from "../escalation/types";
import "../escalation/adapters";

const db = require("../db") as { closeConnection: jest.Mock; createServiceConnection: jest.Mock; executeQuery: jest.Mock };
const graph = require("../graph") as { getGraphToken: jest.Mock };
const auth = require("../auth") as { extractToken: jest.Mock; requireRole: jest.Mock };
const { app } = require("@azure/functions") as { app: { http: jest.Mock; timer: jest.Mock } };

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status?: number; jsonBody?: unknown }>;
// Registered when the module loads, so take it before any test clears the mock.
const triggerPlannerSync = (app.http.mock.calls.find((call) => call[0] === "triggerPlannerSync")![1] as { handler: Handler }).handler;

const APP_BASE_URL = "https://floorplan.example";
const PLANNER_ENV: Record<string, string> = {
  APP_BASE_URL,
  PLANNER_ACCOUNTS_BUCKET_AWAITING_ID: "bucket-awaiting",
  PLANNER_ACCOUNTS_BUCKET_DIRECTOR_ID: "bucket-director",
  PLANNER_ACCOUNTS_BUCKET_ONCHARGE_ID: "bucket-oncharge",
  PLANNER_ACCOUNTS_GROUP_ID: "group-accounts",
  PLANNER_ACCOUNTS_PLAN_ID: "plan-accounts",
  PLANNER_FACILITIES_BUCKET_AWAITING_APPROVAL_ID: "bucket-approval",
  PLANNER_FACILITIES_BUCKET_JOB_UPDATES_ID: "bucket-updates",
  PLANNER_FACILITIES_BUCKET_LOST_KEYS_ID: "bucket-keys",
  PLANNER_FACILITIES_GROUP_ID: "group-facilities",
  PLANNER_FACILITIES_PLAN_ID: "plan-facilities",
};
const NOTIFICATION_ENV: Record<string, string> = {
  GRAPH_CLIENT_ID: "client",
  GRAPH_CLIENT_SECRET: "secret",
  GRAPH_SENDER_EMAIL: "floorplan@example.com",
  GRAPH_TENANT_ID: "tenant",
};
const TOUCHED_ENV = [...Object.keys(PLANNER_ENV), ...Object.keys(NOTIFICATION_ENV), "DEV_EMAIL_OVERRIDE", "PLANNER_SYNC_ENABLED"];

function setEnv(values: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

// ── A fake Microsoft Graph and a fake database ───────────────────────────────

function graphResponse(body: unknown, status = 200) {
  return {
    headers: { get: (name: string) => (name.toLowerCase() === "etag" ? 'W/"etag-1"' : null) },
    json: async () => body,
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function fakeGraph(url: string, init?: { method?: string }) {
  const method = init?.method ?? "GET";
  if (method === "POST" && url.endsWith("/planner/tasks")) return Promise.resolve(graphResponse({ id: "task-1" }));
  if (/\/groups\/[^/]+\/members/.test(url)) return Promise.resolve(graphResponse({ value: [{ id: "user-1" }, { id: "user-2" }] }));
  if (/\/planner\/tasks\/[^/]+(\/details)?$/.test(url)) return Promise.resolve(graphResponse({}));
  throw new Error(`unexpected Graph call: ${method} ${url}`);
}

type SqlRoute = [RegExp, Record<string, unknown>[]];
function routeSql(routes: SqlRoute[]): void {
  db.executeQuery.mockImplementation(async (_connection: unknown, sql: string) => {
    const hit = routes.find(([pattern]) => pattern.test(sql));
    return hit ? hit[1] : [];
  });
}

const sqlText = (): string[] => db.executeQuery.mock.calls.map((call: unknown[]) => String(call[1]));
const graphCalls = (): { method: string; url: string }[] =>
  fetchMock.mock.calls.map((call: unknown[]) => ({
    method: (call[1] as { method?: string } | undefined)?.method ?? "GET",
    url: String(call[0]),
  }));

const connection = {} as Connection;
const context = () => ({ error: jest.fn(), log: jest.fn(), warn: jest.fn() }) as unknown as InvocationContext & { error: jest.Mock; log: jest.Mock };
const request = {} as HttpRequest;

const accountsDeps: AccountsSyncDeps = { accountsMembers: ["acc-1"], appBaseUrl: APP_BASE_URL, connection };
const facilitiesDeps: FacilitiesSyncDeps = { appBaseUrl: APP_BASE_URL, connection, facilitiesMembers: ["fac-1"] };

let fetchMock: jest.Mock;
let warn: jest.SpyInstance;
let savedEnv: Record<string, string | undefined>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  savedEnv = Object.fromEntries(TOUCHED_ENV.map((name) => [name, process.env[name]]));
  setEnv({ ...Object.fromEntries(TOUCHED_ENV.map((name) => [name, undefined])), ...PLANNER_ENV });
  _resetPlannerSyncLogForTests();
  warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  fetchMock = jest.fn(fakeGraph);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  graph.getGraphToken.mockResolvedValue("token");
  db.createServiceConnection.mockResolvedValue(connection);
  db.executeQuery.mockResolvedValue([]);
  auth.extractToken.mockReturnValue("mock-token");
  auth.requireRole.mockResolvedValue(null);
});

afterEach(() => {
  setEnv(savedEnv);
  warn.mockRestore();
  globalThis.fetch = realFetch;
});

// ── Flag unset, APP_BASE_URL and every PLANNER_* id set ──────────────────────

const reconcileParams = {
  assigneeIds: ["acc-1"],
  connection,
  description: "d",
  dueDate: "2026-10-13",
  entityId: 7,
  entityType: "job" as const,
  planType: "accounts" as const,
  shouldHaveTask: true,
  title: "t",
  triggerType: "awaiting_accounts" as const,
};

// Each resolves without touching Planner, the database or Graph.
const NO_OPS: [string, () => Promise<unknown>][] = [
  ["resolveActivePlannerTasks", () => resolveActivePlannerTasks("job", 7, ["stalled_facilities", "director_approval"])],
  ["reconcileTask", () => reconcileTask(reconcileParams)],
  ["syncJobOnchargePending", () => syncJobOnchargePending(7, accountsDeps)],
  ["syncJobAwaitingAccounts", () => syncJobAwaitingAccounts(7, accountsDeps)],
  ["syncJobAwaitingFacilitiesApproval", () => syncJobAwaitingFacilitiesApproval(7, facilitiesDeps)],
  ["syncJobStalled", () => syncJobStalled(7, facilitiesDeps)],
  ["syncJobDirectorApproval", () => syncJobDirectorApproval(7, accountsDeps)],
  ["syncJobActionTriggersStandalone (the job-save reconcile)", () => syncJobActionTriggersStandalone(7, jest.fn())],
  ["syncKeyLostReported", () => syncKeyLostReported(5, { appBaseUrl: APP_BASE_URL, connection, facilitiesMembers: ["fac-1"] })],
  ["syncKeyLostReportedStandalone", () => syncKeyLostReportedStandalone(5, jest.fn())],
  ["plannerSyncTimer", () => plannerSyncTimer({} as Timer, context())],
];

function expectNoPlannerWork(): void {
  expect(fetchMock).not.toHaveBeenCalled();
  expect(graph.getGraphToken).not.toHaveBeenCalled();
  expect(db.createServiceConnection).not.toHaveBeenCalled();
  expect(db.executeQuery).not.toHaveBeenCalled();
}

describe("PLANNER_SYNC_ENABLED unset, APP_BASE_URL and the PLANNER_* ids set", () => {
  it.each(NO_OPS)("%s does nothing", async (_name, run) => {
    await run();
    expectNoPlannerWork();
  });

  it.each(["", "false", "1", "TRUE", "True", " true"])("PLANNER_SYNC_ENABLED=%j is also off", async (value) => {
    setEnv({ PLANNER_SYNC_ENABLED: value });
    const log = jest.fn();
    await syncJobActionTriggersStandalone(7, log);
    await syncKeyLostReportedStandalone(5, log);
    expectNoPlannerWork();
    expect(log).not.toHaveBeenCalled();
  });

  it("skips without writing to the caller's logger: the notice is process-wide, not per call", async () => {
    const log = jest.fn();
    await syncJobActionTriggersStandalone(7, log);
    await syncKeyLostReportedStandalone(5, log);
    expect(log).not.toHaveBeenCalled();
  });

  const GRAPH_PRIMITIVES: [string, () => Promise<unknown>][] = [
    ["graphGetGroupMembers", () => graphGetGroupMembers("group-accounts")],
    [
      "graphCreatePlannerTask",
      () =>
        graphCreatePlannerTask({
          assigneeIds: ["acc-1"],
          bucketId: "bucket-awaiting",
          description: "d",
          dueDate: "2026-10-13",
          planId: "plan-accounts",
          title: "t",
        }),
    ],
    ["graphGetPlannerTask", () => graphGetPlannerTask("task-1")],
    ["graphCompletePlannerTask", () => graphCompletePlannerTask("task-1", "etag")],
  ];

  it.each(GRAPH_PRIMITIVES)("%s refuses to call Graph", async (name, run) => {
    await expect(run()).rejects.toThrow(`${name}: ${PLANNER_SYNC_DISABLED_MESSAGE}`);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(graph.getGraphToken).not.toHaveBeenCalled();
  });

  it("the Planner timer logs nothing and reports no missing settings", async () => {
    const ctx = context();
    await plannerSyncTimer({} as Timer, ctx);
    expect(ctx.log).not.toHaveBeenCalled();
    expect(ctx.error).not.toHaveBeenCalled();
  });

  it("logs the disabled message once for the whole process, however many paths are hit", async () => {
    for (const [, run] of NO_OPS) await run();
    await triggerPlannerSync(request, context());

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Planner sync disabled (PLANNER_SYNC_ENABLED is not "true")');
  });
});

describe("triggerPlannerSync", () => {
  it("answers 200 and says it skipped, without running the sync, when the flag is off", async () => {
    const ctx = context();
    const response = await triggerPlannerSync(request, ctx);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ message: PLANNER_SYNC_DISABLED_MESSAGE, ranAt: expect.any(String), skipped: true });
    expect(ctx.log).not.toHaveBeenCalled();
    expectNoPlannerWork();
  });

  it("checks the caller's role before saying anything about the flag", async () => {
    const forbidden = { jsonBody: { error: "Forbidden" }, status: 403 };
    auth.requireRole.mockResolvedValueOnce(forbidden);
    expect(await triggerPlannerSync(request, context())).toBe(forbidden);

    auth.extractToken.mockReturnValueOnce(null);
    expect((await triggerPlannerSync(request, context())).status).toBe(401);
    expect(warn).not.toHaveBeenCalled();
  });

  it("runs the sync and returns just ranAt when the flag is on", async () => {
    setEnv({ PLANNER_SYNC_ENABLED: "true" });
    const ctx = context();
    const response = await triggerPlannerSync(request, ctx);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ ranAt: expect.any(String) });
    expect(ctx.log).toHaveBeenCalledWith("plannerSyncTimer: starting");
    expect(ctx.log).toHaveBeenCalledWith("plannerSyncTimer: complete");
  });
});

// ── Flag "true": behaviour is what it was ────────────────────────────────────

describe('PLANNER_SYNC_ENABLED="true"', () => {
  beforeEach(() => setEnv({ PLANNER_SYNC_ENABLED: "true" }));

  it("never logs the disabled message", async () => {
    await syncJobActionTriggersStandalone(7);
    expect(warn).not.toHaveBeenCalled();
  });

  it("graphCreatePlannerTask creates the task, then sets its description", async () => {
    const taskId = await graphCreatePlannerTask({
      assigneeIds: ["acc-1"],
      bucketId: "bucket-awaiting",
      description: "Awaiting accounts action",
      dueDate: "2026-10-13",
      planId: "plan-accounts",
      title: "t",
    });

    expect(taskId).toBe("task-1");
    expect(graphCalls()).toEqual([
      { method: "POST", url: "https://graph.microsoft.com/v1.0/planner/tasks" },
      { method: "GET", url: "https://graph.microsoft.com/v1.0/planner/tasks/task-1/details" },
      { method: "PATCH", url: "https://graph.microsoft.com/v1.0/planner/tasks/task-1/details" },
    ]);
  });

  it("completes a task through get then patch", async () => {
    const task = await graphGetPlannerTask("task-1");
    await graphCompletePlannerTask("task-1", task!.etag);
    expect(graphCalls().map((call) => call.method)).toEqual(["GET", "PATCH"]);
    expect(await graphGetGroupMembers("group-accounts")).toEqual(["user-1", "user-2"]);
  });

  it("resolveActivePlannerTasks completes the Graph task and marks the row resolved", async () => {
    routeSql([[/FROM dbo\.PlannerTasks/, [{ Id: 5, PlannerTaskId: "task-9" }]]]);

    await resolveActivePlannerTasks("job", 7, ["director_approval"]);

    expect(graphCalls()).toEqual([
      { method: "GET", url: "https://graph.microsoft.com/v1.0/planner/tasks/task-9" },
      { method: "PATCH", url: "https://graph.microsoft.com/v1.0/planner/tasks/task-9" },
    ]);
    expect(sqlText().some((sql) => /UPDATE dbo\.PlannerTasks/.test(sql) && /Status = 'resolved'/.test(sql))).toBe(true);
    expect(db.closeConnection).toHaveBeenCalledWith(connection);
  });

  it("a job that is awaiting accounts gets a Planner task whose link is built from APP_BASE_URL", async () => {
    routeSql([
      [/FROM dbo\.Jobs j/, [{ AssignedToEntraOid: null, AwaitingRole: "accounts", BuildingName: "9 Cavanagh", IsArchived: 0, JobID: 7, Status: "In Progress", Title: "Leaking roof" }]],
    ]);

    await syncJobAwaitingAccounts(7, accountsDeps);

    const create = fetchMock.mock.calls.find((call) => (call[1] as { method?: string } | undefined)?.method === "POST")!;
    expect(JSON.parse((create[1] as { body: string }).body)).toMatchObject({
      assignments: { "acc-1": expect.any(Object) },
      bucketId: "bucket-awaiting",
      planId: "plan-accounts",
    });
    const description = fetchMock.mock.calls.find((call) => (call[1] as { method?: string } | undefined)?.method === "PATCH")![1] as { body: string };
    expect(JSON.parse(description.body).description).toContain(`${APP_BASE_URL}/jobs?jobId=7`);
    expect(sqlText().some((sql) => /INSERT INTO dbo\.PlannerTasks/.test(sql))).toBe(true);
  });

  it("the job-save reconcile loads both groups and checks all five triggers", async () => {
    await syncJobActionTriggersStandalone(7);

    expect(graphCalls().map((call) => call.url).sort()).toEqual([
      "https://graph.microsoft.com/v1.0/groups/group-accounts/members?$select=id",
      "https://graph.microsoft.com/v1.0/groups/group-facilities/members?$select=id",
    ]);
    expect(db.executeQuery).toHaveBeenCalledTimes(5);
    expect(db.closeConnection).toHaveBeenCalledWith(connection);
  });

  it.each(["APP_BASE_URL", "PLANNER_FACILITIES_GROUP_ID", "PLANNER_ACCOUNTS_GROUP_ID"])(
    "the job-save reconcile still skips, saying so, when %s is unset",
    async (name) => {
      setEnv({ [name]: undefined });
      const log = jest.fn();

      await syncJobActionTriggersStandalone(7, log);

      expect(log).toHaveBeenCalledWith(expect.stringContaining("missing required env"));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(db.createServiceConnection).not.toHaveBeenCalled();
    },
  );

  it("the lost-key sync loads the facilities group; without APP_BASE_URL it still skips", async () => {
    const log = jest.fn();
    await syncKeyLostReportedStandalone(5, log);
    expect(graphCalls().map((call) => call.url)).toEqual(["https://graph.microsoft.com/v1.0/groups/group-facilities/members?$select=id"]);
    expect(log).toHaveBeenCalledWith("syncKeyLostReported: key 5 not found — skipping");

    fetchMock.mockClear();
    setEnv({ APP_BASE_URL: undefined });
    await syncKeyLostReportedStandalone(5, log);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the nightly timer loads both groups and runs to the end", async () => {
    const ctx = context();
    await plannerSyncTimer({} as Timer, ctx);

    expect(graphCalls()).toHaveLength(2);
    expect(ctx.log).toHaveBeenCalledWith("plannerSyncTimer: starting");
    expect(ctx.log).toHaveBeenCalledWith("plannerSyncTimer: complete");
    expect(ctx.error).not.toHaveBeenCalled();
  });

  it("the nightly timer still stops, reporting it, when APP_BASE_URL is unset", async () => {
    setEnv({ APP_BASE_URL: undefined });
    const ctx = context();

    await plannerSyncTimer({} as Timer, ctx);

    expect(ctx.error).toHaveBeenCalledWith(expect.stringContaining("missing"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.createServiceConnection).not.toHaveBeenCalled();
  });
});

// ── APP_BASE_URL only builds links ───────────────────────────────────────────

const FAY: DirectoryUser = { email: "fay@example.com", name: "Fay", role: "facilities", userId: 8 };
const ADAM: DirectoryUser = { email: "adam@example.com", name: "Adam", role: "facilities_manager", userId: 1 };

function escalationRow(): EscalationRow {
  return {
    acknowledgedAt: null,
    acknowledgedByName: null,
    acknowledgedByUserId: null,
    buildingId: 5,
    context: null,
    createdAt: new Date("2026-10-13T00:00:00Z"),
    dueAt: new Date("2026-10-13T08:00:00Z"),
    escalationId: 42,
    kind: "attention",
    lastFollowUpAt: null,
    lastNotificationAttemptAt: null,
    lastNotificationError: null,
    lastNotifiedAt: null,
    level: 1,
    noIndependentTarget: false,
    note: null,
    notificationAttempts: 0,
    notificationState: "pending",
    parentEscalationId: null,
    policyKey: "job.manual",
    raisedByKind: "user",
    raisedByName: "Fay",
    raisedByUserId: 8,
    reason: "needs_decision",
    resolutionCode: null,
    resolutionNote: null,
    resolvedAt: null,
    resolvedByName: null,
    resolvedByUserId: null,
    rowVersion: "AAAAAAAAB9A=",
    status: "open",
    subjectId: "12",
    subjectType: "job",
    summary: "Job #12 · Leaking roof",
    targetRole: "facilities_manager",
    targetUserId: null,
    updatedAt: new Date("2026-10-13T00:00:00Z"),
    urgent: false,
  };
}

describe("APP_BASE_URL builds links; it does not switch Planner on", () => {
  beforeEach(() => setEnv(NOTIFICATION_ENV));

  it.each([undefined, "true"])("with PLANNER_SYNC_ENABLED=%p an escalation email links to the job from APP_BASE_URL", async (flag) => {
    setEnv({ PLANNER_SYNC_ENABLED: flag });
    const sendMail = jest.fn().mockResolvedValue(undefined);

    const outcome = await notifyTargets(connection, escalationRow(), "raise", { now: () => new Date("2026-10-13T01:00:00Z"), sendMail, users: [FAY, ADAM] });

    expect(outcome).toMatchObject({ error: null, state: "sent" });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0]).toEqual(["adam@example.com"]);
    expect(sendMail.mock.calls[0][2]).toContain(`${APP_BASE_URL}/jobs?jobId=12`);
  });

  it("builds the same links with the flag unset, and sends nothing to Planner", () => {
    expect(appBaseUrl()).toBe(APP_BASE_URL);
    expect(absoluteLink("/escalations")).toBe(`${APP_BASE_URL}/escalations`);
    expect(process.env.PLANNER_SYNC_ENABLED).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still reports APP_BASE_URL as missing for system.health, flag or no flag", async () => {
    expect(missingNotificationConfig()).toEqual([]);
    const ref = { policyKey: "system.health", subjectId: SYSTEM_SUBJECTS.notificationConfig, subjectType: "system" };
    expect(await systemAdapter.isConditionActive(connection, ref, new Date())).toBe(false);

    setEnv({ APP_BASE_URL: undefined });
    expect(missingNotificationConfig()).toEqual(["APP_BASE_URL"]);
    expect(await systemAdapter.isConditionActive(connection, ref, new Date())).toBe(true);

    setEnv({ PLANNER_SYNC_ENABLED: "true" });
    expect(missingNotificationConfig()).toEqual(["APP_BASE_URL"]);
  });

  it("an escalation email waits, rather than going without a link, while APP_BASE_URL is unset", async () => {
    setEnv({ APP_BASE_URL: undefined });
    const sendMail = jest.fn().mockResolvedValue(undefined);

    const outcome = await notifyTargets(connection, escalationRow(), "raise", { sendMail, users: [ADAM] });

    expect(outcome).toMatchObject({ attempts: 0, state: "pending" });
    expect(outcome.error).toContain("APP_BASE_URL");
    expect(sendMail).not.toHaveBeenCalled();
  });
});
