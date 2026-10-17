/// <reference types="jest" />
import {
  _resetPlannerSyncLogForTests,
  PLANNER_SYNC_DISABLED_MESSAGE,
  plannerSyncEnabled,
  plannerUnsignedHoldbackEnabled,
} from "../plannerFlag";

describe("plannerSyncEnabled", () => {
  let warn: jest.SpyInstance;
  const originalFlag = process.env.PLANNER_SYNC_ENABLED;

  beforeEach(() => {
    _resetPlannerSyncLogForTests();
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    if (originalFlag === undefined) delete process.env.PLANNER_SYNC_ENABLED;
    else process.env.PLANNER_SYNC_ENABLED = originalFlag;
  });

  it("is on only when PLANNER_SYNC_ENABLED is exactly the string true", () => {
    expect(plannerSyncEnabled({ PLANNER_SYNC_ENABLED: "true" })).toBe(true);
  });

  it.each([undefined, "", "false", "TRUE", "True", "1", "yes", " true", "true "])("is off when it is %p", (value) => {
    expect(plannerSyncEnabled({ PLANNER_SYNC_ENABLED: value })).toBe(false);
  });

  it("is not switched on by APP_BASE_URL or by the PLANNER_* ids and buckets", () => {
    const env = {
      APP_BASE_URL: "https://floorplan.example",
      PLANNER_ACCOUNTS_BUCKET_AWAITING_ID: "bucket",
      PLANNER_ACCOUNTS_GROUP_ID: "group",
      PLANNER_ACCOUNTS_PLAN_ID: "plan",
      PLANNER_FACILITIES_GROUP_ID: "group",
      PLANNER_FACILITIES_PLAN_ID: "plan",
    } as NodeJS.ProcessEnv;
    expect(plannerSyncEnabled(env)).toBe(false);
  });

  it("reads process.env when no env is passed", () => {
    delete process.env.PLANNER_SYNC_ENABLED;
    expect(plannerSyncEnabled()).toBe(false);
    process.env.PLANNER_SYNC_ENABLED = "true";
    expect(plannerSyncEnabled()).toBe(true);
  });

  it("logs the disabled message once per process, not once per call", () => {
    plannerSyncEnabled({});
    plannerSyncEnabled({});
    plannerSyncEnabled({ PLANNER_SYNC_ENABLED: "false" });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Planner sync disabled (PLANNER_SYNC_ENABLED is not "true")');
    expect(PLANNER_SYNC_DISABLED_MESSAGE).toBe('Planner sync disabled (PLANNER_SYNC_ENABLED is not "true")');
  });

  it("logs nothing while it is on", () => {
    plannerSyncEnabled({ PLANNER_SYNC_ENABLED: "true" });
    plannerSyncEnabled({ PLANNER_SYNC_ENABLED: "true" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("still logs on the first disabled call after some enabled ones", () => {
    plannerSyncEnabled({ PLANNER_SYNC_ENABLED: "true" });
    plannerSyncEnabled({});
    plannerSyncEnabled({});
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("plannerUnsignedHoldbackEnabled", () => {
  it("is on only when PLANNER_UNSIGNED_HOLDBACK_ENABLED is exactly the string true", () => {
    expect(plannerUnsignedHoldbackEnabled({ PLANNER_UNSIGNED_HOLDBACK_ENABLED: "true" })).toBe(true);
  });

  it.each([undefined, "", "false", "TRUE", "True", "1", "yes", " true", "true "])("is off when it is %p", (value) => {
    expect(plannerUnsignedHoldbackEnabled({ PLANNER_UNSIGNED_HOLDBACK_ENABLED: value })).toBe(false);
  });

  it("is not switched on by PLANNER_SYNC_ENABLED, and does not switch Planner sync on", () => {
    expect(plannerUnsignedHoldbackEnabled({ PLANNER_SYNC_ENABLED: "true" })).toBe(false);
    expect(plannerSyncEnabled({ PLANNER_UNSIGNED_HOLDBACK_ENABLED: "true" })).toBe(false);
  });

  it("reads process.env when no env is passed", () => {
    const before = process.env.PLANNER_UNSIGNED_HOLDBACK_ENABLED;
    try {
      delete process.env.PLANNER_UNSIGNED_HOLDBACK_ENABLED;
      expect(plannerUnsignedHoldbackEnabled()).toBe(false);
      process.env.PLANNER_UNSIGNED_HOLDBACK_ENABLED = "true";
      expect(plannerUnsignedHoldbackEnabled()).toBe(true);
    } finally {
      if (before === undefined) delete process.env.PLANNER_UNSIGNED_HOLDBACK_ENABLED;
      else process.env.PLANNER_UNSIGNED_HOLDBACK_ENABLED = before;
    }
  });
});
