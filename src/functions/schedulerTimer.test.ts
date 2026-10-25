/// <reference types="jest" />
import { InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createServiceRequestConnection: jest.fn().mockResolvedValue({ id: "conn" }),
  executeQuery: jest.fn(),
}));
jest.mock("../facilitiesScheduler", () => {
  const actual = jest.requireActual("../facilitiesScheduler");
  return { ...actual, runFacilitiesScheduler: jest.fn() };
});
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn(), flush: jest.fn().mockResolvedValue(true) } }));

import { runSchedulerTimer } from "./schedulerTimer";

const { app } = require("@azure/functions") as { app: { timer: jest.Mock } };
const db = require("../db") as { closeConnection: jest.Mock; createServiceRequestConnection: jest.Mock; executeQuery: jest.Mock };
const scheduler = require("../facilitiesScheduler") as { runFacilitiesScheduler: jest.Mock };
const { Sentry } = require("../sentry") as { Sentry: { captureException: jest.Mock; captureMessage: jest.Mock } };

const registrations = [...app.timer.mock.calls];

const counts = { alreadyOpen: 0, considered: 0, raised: 0, skippedAlreadySent: 0, wouldRaise: 0 };
const report = (errors: string[] = [], truncated = false) => ({
  actions: 0,
  defects: counts,
  errors,
  overdue: counts,
  schedules: { alreadyDone: 0, considered: 0, created: 0, skippedDefects: 0, wouldCreate: 0, wouldSkip: 0 },
  truncated,
});

beforeEach(() => {
  jest.clearAllMocks();
  scheduler.runFacilitiesScheduler.mockResolvedValue(report());
  db.executeQuery.mockImplementation(async (_connection: unknown, sql: string) => (/INSERT INTO dbo\.TimerRuns/.test(sql) ? [{ TimerRunId: 9 }] : []));
});

it("is registered daily at 22:00 UTC (07:30 in Darwin)", () => {
  expect(registrations).toContainEqual(["schedulerTimer", expect.objectContaining({ schedule: "0 0 22 * * *" })]);
});

it("does nothing and opens no connection when it is off", async () => {
  const result = await runSchedulerTimer(new InvocationContext(), {});
  expect(result).toBeNull();
  expect(db.createServiceRequestConnection).not.toHaveBeenCalled();
});

it("runs as a dry run when SCHEDULER_DRY_RUN is true, even if enabled", async () => {
  await runSchedulerTimer(new InvocationContext(), { SCHEDULER_DRY_RUN: "true", SCHEDULER_ENABLED: "true" });
  expect(scheduler.runFacilitiesScheduler).toHaveBeenCalledWith({ id: "conn" }, expect.objectContaining({ dryRun: true }));
  expect(db.closeConnection).toHaveBeenCalled();
});

it("runs live and reports per-record failures to Sentry", async () => {
  scheduler.runFacilitiesScheduler.mockResolvedValue(report(["defects period 1: boom"]));
  await runSchedulerTimer(new InvocationContext(), { SCHEDULER_ENABLED: "true" });
  expect(scheduler.runFacilitiesScheduler).toHaveBeenCalledWith({ id: "conn" }, expect.objectContaining({ dryRun: false }));
  expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.stringMatching(/1 problem/), "error");
});

it("passes SCHEDULER_MAX_ACTIONS through and warns when the run was cut short", async () => {
  scheduler.runFacilitiesScheduler.mockResolvedValue(report([], true));
  await runSchedulerTimer(new InvocationContext(), { SCHEDULER_ENABLED: "true", SCHEDULER_MAX_ACTIONS: "25" });
  expect(scheduler.runFacilitiesScheduler).toHaveBeenCalledWith({ id: "conn" }, expect.objectContaining({ maxActions: 25 }));
  expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.stringMatching(/action limit/), "warning");
});

it("returns one flat set of counts, errors included, for runTimer (integration note)", async () => {
  scheduler.runFacilitiesScheduler.mockResolvedValue({
    ...report(["defects period 1: boom"], true),
    defects: { ...counts, raised: 2 },
    overdue: { ...counts, raised: 1 },
    schedules: { alreadyDone: 0, considered: 3, created: 2, skippedDefects: 1, wouldCreate: 0, wouldSkip: 0 },
  });
  const result = await runSchedulerTimer(new InvocationContext(), { SCHEDULER_ENABLED: "true" });
  expect(result).toEqual({
    alreadyDone: 0,
    created: 2,
    errors: 1,
    escalated: 1,
    mode: "live",
    remindersRaised: 2,
    skippedDefects: 1,
    truncated: true,
    wouldCreate: 0,
    wouldEscalate: 0,
    wouldRemind: 0,
    wouldSkip: 0,
  });
});

it("fails loudly when the run itself throws", async () => {
  scheduler.runFacilitiesScheduler.mockRejectedValue(new Error("no database"));
  await expect(runSchedulerTimer(new InvocationContext(), { SCHEDULER_ENABLED: "true" })).rejects.toThrow("no database");
  expect(Sentry.captureException).toHaveBeenCalled();
  expect(db.closeConnection).toHaveBeenCalled();
});

// Review F2 finding 2: the registered handler dropped the counts, so TimerRuns stored Counts null and
// Outcome 'ok' even when the run had errors, and /api/health?deep=true saw a clean run.
describe("the registered handler (through runTimer)", () => {
  const handler = registrations.find(([name]) => name === "schedulerTimer")?.[1].handler as (timer: unknown, context: InvocationContext) => Promise<void>;
  const finishRow = () => {
    const call = db.executeQuery.mock.calls.find(([, sql]: [unknown, string]) => /UPDATE dbo\.TimerRuns/.test(sql));
    return Object.fromEntries(((call?.[2] ?? []) as Array<{ name: string; value: unknown }>).map((p) => [p.name, p.value]));
  };
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("records the counts and 'ok' for a clean live run", async () => {
    process.env.SCHEDULER_ENABLED = "true";
    await handler({}, new InvocationContext());
    expect(finishRow()).toMatchObject({ Error: null, Outcome: "ok" });
    expect(JSON.parse(String(finishRow().Counts))).toMatchObject({ created: 0, errors: 0, mode: "live" });
  });

  it("fails the run, with the first problem in the message, when the scheduler reported errors", async () => {
    process.env.SCHEDULER_ENABLED = "true";
    scheduler.runFacilitiesScheduler.mockResolvedValue(report(["defects period 1: boom", "schedule 4: also boom"]));
    await expect(handler({}, new InvocationContext())).rejects.toThrow("2 problem(s); first: defects period 1: boom");
    expect(finishRow()).toMatchObject({ Outcome: "error" });
    expect(String(finishRow().Error)).toContain("defects period 1: boom");
  });

  it("records the mode when it is off, rather than an empty row", async () => {
    delete process.env.SCHEDULER_ENABLED;
    delete process.env.SCHEDULER_DRY_RUN;
    await handler({}, new InvocationContext());
    expect(finishRow()).toMatchObject({ Counts: '{"mode":"off"}', Outcome: "ok" });
    expect(scheduler.runFacilitiesScheduler).not.toHaveBeenCalled();
  });
});
