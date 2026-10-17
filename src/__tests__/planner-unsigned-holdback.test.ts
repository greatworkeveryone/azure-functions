/// <reference types="jest" />
import type { InvocationContext, Timer } from "@azure/functions";
import type { Connection } from "tedious";

// PLAN D7 / D21: a tenancy whose schedule nobody has signed off gets no lease
// Planner tasks. Taking down the ones already open is opt-in, because it is a
// bulk change to live Planner data: PLANNER_UNSIGNED_HOLDBACK_ENABLED must equal
// "true". Run through the real timer, with Graph and the database faked.

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createServiceConnection: jest.fn(),
  executeQuery: jest.fn(),
}));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), flush: jest.fn().mockResolvedValue(true) } }));
jest.mock("../planner", () => ({
  getPlanConfig: jest.fn().mockReturnValue({ bucketId: "bucket", planId: "plan" }),
  graphCompletePlannerTask: jest.fn(),
  graphCreatePlannerTask: jest.fn(),
  graphGetGroupMembers: jest.fn().mockResolvedValue(["member-1"]),
  graphGetPlannerTask: jest.fn(),
  resolveActivePlannerTasks: jest.fn().mockResolvedValue(undefined),
}));

import { plannerSyncTimer } from "../functions/plannerSyncTimer";
import { _resetPlannerSyncLogForTests } from "../plannerFlag";
import { addDaysUTC, toIsoDateString } from "../plannerHelpers";

const db = require("../db") as { createServiceConnection: jest.Mock; executeQuery: jest.Mock };
const planner = require("../planner") as { graphCreatePlannerTask: jest.Mock; resolveActivePlannerTasks: jest.Mock };

const ENV = ["PLANNER_SYNC_ENABLED", "PLANNER_UNSIGNED_HOLDBACK_ENABLED", "APP_BASE_URL", "PLANNER_FACILITIES_GROUP_ID", "PLANNER_FACILITIES_PLAN_ID", "PLANNER_ACCOUNTS_GROUP_ID", "PLANNER_ACCOUNTS_PLAN_ID"];
let saved: Record<string, string | undefined>;

const SIGNED = 11;
const UNSIGNED_WITH_TASKS = 22;
const UNSIGNED_NO_TASKS = 33;
// A lease ending in 20 days is inside the 30, 60 and 90-day windows: three tasks each.
const EXPIRY = toIsoDateString(addDaysUTC(new Date(), 20));
const tenantRow = (id: number, signed: boolean) => ({
  BuildingName: "Harbour House",
  Expiry: EXPIRY,
  FirstOccupancy: "L1 / Suite 1",
  LegalName: `Tenant ${id} Pty Ltd`,
  NextReviewDate: null,
  OptionNoticeMonths: null,
  OptionPeriods: null,
  ReviewType: null,
  ScheduleSignedOffAt: signed ? new Date("2026-10-01T00:00:00Z") : null,
  TenantId: id,
  TradingName: null,
});
const activeTask = (tenantId: number, leadTimeDays: number, id: number) => ({
  EntityId: tenantId,
  EntityType: "tenant",
  Id: id,
  LeadTimeDays: leadTimeDays,
  PlannerTaskId: `planner-${id}`,
  Status: "active",
  TriggerType: "lease_expiry",
});

const context = () => ({ error: jest.fn(), log: jest.fn(), warn: jest.fn() }) as unknown as InvocationContext & { error: jest.Mock; log: jest.Mock; warn: jest.Mock };
const logged = (ctx: { log: jest.Mock; warn: jest.Mock }) => [...ctx.log.mock.calls, ...ctx.warn.mock.calls].map((call) => call.join(" ")).join("\n");
const createdFor = () => planner.graphCreatePlannerTask.mock.calls.map((call) => String(call[0].title));

beforeEach(() => {
  jest.clearAllMocks();
  saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    APP_BASE_URL: "https://floorplan.example",
    PLANNER_ACCOUNTS_GROUP_ID: "group-a",
    PLANNER_ACCOUNTS_PLAN_ID: "plan-a",
    PLANNER_FACILITIES_GROUP_ID: "group-f",
    PLANNER_FACILITIES_PLAN_ID: "plan-f",
    PLANNER_SYNC_ENABLED: "true",
  });
  delete process.env.PLANNER_UNSIGNED_HOLDBACK_ENABLED;
  _resetPlannerSyncLogForTests();
  db.createServiceConnection.mockResolvedValue({} as Connection);
  planner.graphCreatePlannerTask.mockResolvedValue("new-task");
  db.executeQuery.mockImplementation(async (_connection: unknown, sql: string) => {
    if (/FROM dbo\.Tenants t/.test(sql)) {
      return [tenantRow(SIGNED, true), tenantRow(UNSIGNED_WITH_TASKS, false), tenantRow(UNSIGNED_NO_TASKS, false)];
    }
    if (/FROM dbo\.PlannerTasks/.test(sql) && /EntityType = 'tenant'/.test(sql)) {
      return [activeTask(UNSIGNED_WITH_TASKS, 90, 21), activeTask(UNSIGNED_WITH_TASKS, 60, 22)];
    }
    return [];
  });
});

afterEach(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("the nightly timer and a schedule nobody has signed off", () => {
  it("never creates a task for an unsigned tenancy, whatever the removal switch says", async () => {
    for (const switchValue of [undefined, "true"]) {
      planner.graphCreatePlannerTask.mockClear();
      if (switchValue) process.env.PLANNER_UNSIGNED_HOLDBACK_ENABLED = switchValue;
      await plannerSyncTimer({} as Timer, context());
      const titles = createdFor();
      expect(titles).toHaveLength(3);
      for (const title of titles) expect(title).toContain("Tenant 11 Pty Ltd");
      expect(titles.some((title) => /Tenant (22|33) Pty Ltd/.test(title))).toBe(false);
    }
  });

  it("leaves tasks that are already open alone while PLANNER_UNSIGNED_HOLDBACK_ENABLED is not true", async () => {
    for (const value of [undefined, "", "false", "TRUE", "1"]) {
      planner.resolveActivePlannerTasks.mockClear();
      if (value === undefined) delete process.env.PLANNER_UNSIGNED_HOLDBACK_ENABLED;
      else process.env.PLANNER_UNSIGNED_HOLDBACK_ENABLED = value;
      await plannerSyncTimer({} as Timer, context());
      expect(planner.resolveActivePlannerTasks).not.toHaveBeenCalled();
    }
  });

  it("says, while the removal is off, which tenancies and how many open tasks it left alone", async () => {
    const ctx = context();
    await plannerSyncTimer({} as Timer, ctx);
    const text = logged(ctx);
    expect(text).toMatch(/PLANNER_UNSIGNED_HOLDBACK_ENABLED/);
    expect(text).toMatch(/not removed|left/i);
    expect(text).toContain(String(UNSIGNED_WITH_TASKS));
    expect(text).toMatch(/2 open (lease )?tasks?/);
    expect(text).not.toContain(String(SIGNED));
    expect(text).not.toContain(String(UNSIGNED_NO_TASKS));
  });

  it("takes down the open lease tasks of an unsigned tenancy, and only that one, when the switch is true", async () => {
    process.env.PLANNER_UNSIGNED_HOLDBACK_ENABLED = "true";
    const ctx = context();
    await plannerSyncTimer({} as Timer, ctx);

    expect(planner.resolveActivePlannerTasks).toHaveBeenCalledTimes(1);
    expect(planner.resolveActivePlannerTasks).toHaveBeenCalledWith("tenant", UNSIGNED_WITH_TASKS, ["lease_expiry", "option_notice", "rent_review"]);
    const text = logged(ctx);
    expect(text).toContain(String(UNSIGNED_WITH_TASKS));
    expect(text).toMatch(/removed 2 (open )?(lease )?tasks?/i);
  });

  it("keeps the signed-off tenancy's tasks coming either way", async () => {
    await plannerSyncTimer({} as Timer, context());
    expect(createdFor()).toHaveLength(3);
    process.env.PLANNER_UNSIGNED_HOLDBACK_ENABLED = "true";
    planner.graphCreatePlannerTask.mockClear();
    await plannerSyncTimer({} as Timer, context());
    expect(createdFor()).toHaveLength(3);
  });

  it("does nothing at all about unsigned tenancies when Planner sync itself is off", async () => {
    process.env.PLANNER_SYNC_ENABLED = "false";
    process.env.PLANNER_UNSIGNED_HOLDBACK_ENABLED = "true";
    await plannerSyncTimer({} as Timer, context());
    expect(db.executeQuery).not.toHaveBeenCalled();
    expect(planner.resolveActivePlannerTasks).not.toHaveBeenCalled();
    expect(planner.graphCreatePlannerTask).not.toHaveBeenCalled();
  });
});
