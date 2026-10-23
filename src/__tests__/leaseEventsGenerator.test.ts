/// <reference types="jest" />
// The lease events generator (WP32, WP33): the pure plan (positive selection,
// horizons, lapse, renewal, idempotence), the dry run (reads only), the switch
// (off touches nothing) and a live run's writes and escalations.
import type { InvocationContext, Timer } from "@azure/functions";
import { ledgerInserts } from "./fixtures/ledgerCalls";

jest.mock("../db", () => ({
  beginTransaction: jest.fn(),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn(),
  createServiceRequestConnection: jest.fn(),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn(),
}));
jest.mock("../escalation", () => ({ concludeForSubject: jest.fn().mockResolvedValue([]), raise: jest.fn().mockResolvedValue({ created: true, escalation: {} }) }));
jest.mock("../tenant-register-cache", () => ({ invalidateTenantAndBuilding: jest.fn() }));

import { leaseEventsGeneratorTimer } from "../functions/leaseEventsGeneratorTimer";
import {
  type GeneratorEvent,
  type GeneratorTenancy,
  generatorMode,
  planLeaseEvents,
  runLeaseEventsGenerator,
  toGeneratorTenancy,
} from "../leaseEvents/generator";

const db = jest.requireMock("../db") as Record<string, jest.Mock>;
const escalation = jest.requireMock("../escalation") as { raise: jest.Mock };

const TODAY = "2026-10-23";

function tenancy(over: Partial<Record<string, unknown>> = {}): GeneratorTenancy {
  return toGeneratorTenancy(
    { BuildingId: 3, Expiry: "2027-12-31", LegalName: "Acme Pty Ltd", OptionNoticeMonths: 6, OptionPeriods: "1 x 5 years", TenantId: 7, ...over },
    TODAY,
  ) as GeneratorTenancy;
}

const event = (over: Partial<GeneratorEvent>): GeneratorEvent => ({
  deadlineOn: "2027-06-30",
  leaseEventId: "ev-1",
  leaseExpiry: "2027-12-31",
  state: "window_not_open",
  tenantId: 7,
  type: "option_exercise",
  windowOpensOn: "2026-12-30",
  ...over,
});

describe("planLeaseEvents: options", () => {
  it("opens an option event within 90 days of its window, not earlier", () => {
    // Expiry 31 Dec 2027, 6 months' notice: deadline 30 Jun 2027, window opens 30 Dec 2026 (68 days away).
    expect(planLeaseEvents([tenancy()], [], TODAY).actions).toEqual([
      expect.objectContaining({ deadline: "2027-06-30", expiry: "2027-12-31", kind: "open_option", opensAt: "2026-12-30", windowOpen: false }),
    ]);
    expect(planLeaseEvents([tenancy({ Expiry: "2028-06-30" })], [], TODAY).actions).toEqual([]);
  });

  it("opens it already open when today is inside the window", () => {
    expect(planLeaseEvents([tenancy({ Expiry: "2027-06-30" })], [], TODAY).actions[0]).toMatchObject({ kind: "open_option", windowOpen: true });
  });

  it("does nothing for a lease with no option left, none at all, or no notice period", () => {
    for (const over of [{ OptionsRemaining: 0, OptionsTotal: 2 }, { OptionPeriods: "Nil" }, { OptionNoticeMonths: null }]) {
      expect(planLeaseEvents([tenancy({ ...over, Expiry: "2027-12-31" })], [], TODAY).actions.filter((a) => a.kind === "open_option")).toEqual([]);
    }
  });

  it("opens the window on its day and lapses an unanswered one after its deadline", () => {
    expect(planLeaseEvents([tenancy()], [event({ windowOpensOn: "2026-10-23" })], TODAY).actions[0]).toMatchObject({ kind: "open_window", leaseEventId: "ev-1" });
    expect(planLeaseEvents([tenancy()], [event({ deadlineOn: "2026-10-22", state: "window_open" })], TODAY).actions[0]).toMatchObject({ kind: "lapse" });
    expect(planLeaseEvents([tenancy()], [event({ deadlineOn: "2026-10-23", state: "window_open" })], TODAY).actions[0]).toMatchObject({ kind: "deadline_warning" });
  });

  it("warns only inside 30 days of the deadline, and never once a notice is recorded", () => {
    expect(planLeaseEvents([tenancy()], [event({ deadlineOn: "2026-11-23", state: "window_open" })], TODAY).actions).toEqual([]);
    expect(planLeaseEvents([tenancy()], [event({ deadlineOn: "2026-11-22", state: "window_open" })], TODAY).actions[0]).toMatchObject({ kind: "deadline_warning" });
    expect(planLeaseEvents([tenancy()], [event({ deadlineOn: "2026-11-01", state: "awaiting_approval" })], TODAY).actions).toEqual([]);
  });

  it("raises no lapse for a window that closed before any event existed (no first-run wave)", () => {
    const plan = planLeaseEvents([tenancy({ Expiry: "2027-03-31" })], [], TODAY);
    expect(plan.actions.filter((a) => a.kind !== "refer_renewal")).toEqual([]);
    expect(plan.unrecordedLapses).toBe(1);
  });

  it("is idempotent: an event already decided for this expiry opens nothing new", () => {
    for (const state of ["exercised", "rejected", "lapsed", "cancelled"] as const) {
      expect(planLeaseEvents([tenancy()], [event({ state })], TODAY).actions.filter((a) => a.kind === "open_option")).toEqual([]);
    }
  });
});

describe("planLeaseEvents: renewals", () => {
  const inside = { Expiry: "2027-03-31", OptionPeriods: "Nil" };

  it("refers a lease with no option left at 180 days to expiry, not at 181", () => {
    expect(planLeaseEvents([tenancy({ ...inside, Expiry: "2027-04-21" })], [], TODAY).actions).toEqual([
      expect.objectContaining({ expiry: "2027-04-21", kind: "refer_renewal" }),
    ]);
    expect(planLeaseEvents([tenancy({ ...inside, Expiry: "2027-04-22" })], [], TODAY).actions).toEqual([]);
  });

  it("refers one held over past its expiry, and one whose option lapsed or was rejected", () => {
    expect(planLeaseEvents([tenancy({ ...inside, Expiry: "2026-01-31" })], [], TODAY).actions[0]).toMatchObject({ kind: "refer_renewal" });
    for (const state of ["lapsed", "rejected"] as const) {
      const plan = planLeaseEvents([tenancy({ Expiry: "2027-03-31" })], [event({ leaseExpiry: "2027-03-31", state })], TODAY);
      expect(plan.actions).toEqual([expect.objectContaining({ kind: "refer_renewal" })]);
    }
  });

  it("does not refer while an option is live, was exercised, or a renewal is open or decided for this expiry", () => {
    const t = tenancy({ Expiry: "2027-03-31" });
    expect(planLeaseEvents([t], [event({ leaseExpiry: "2027-03-31", state: "awaiting_approval" })], TODAY).actions).toEqual([]);
    expect(planLeaseEvents([t], [event({ leaseExpiry: "2027-03-31", state: "exercised" })], TODAY).actions).toEqual([]);
    const renewal = (state: GeneratorEvent["state"], leaseExpiry: string) => event({ leaseEventId: "rn", leaseExpiry, state, type: "renewal" });
    const noOptions = tenancy(inside);
    expect(planLeaseEvents([noOptions], [renewal("referred", "2027-03-31")], TODAY).actions).toEqual([]);
    expect(planLeaseEvents([noOptions], [renewal("holdover", "2027-03-31")], TODAY).actions).toEqual([]);
    // A renewal decided for an earlier expiry doesn't count for this one.
    expect(planLeaseEvents([noOptions], [renewal("renewed", "2022-03-31")], TODAY).actions).toHaveLength(1);
  });

  it("orders the actions soonest first", () => {
    const plan = planLeaseEvents([tenancy({ ...inside, Expiry: "2027-03-31", TenantId: 9 }), tenancy({ ...inside, Expiry: "2026-12-31", TenantId: 8 })], [], TODAY);
    expect(plan.actions.map((a) => a.tenantId)).toEqual([8, 9]);
  });
});

describe("the switch", () => {
  const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
  afterEach(() => {
    delete process.env.LEASE_EVENTS_GENERATOR_ENABLED;
    delete process.env.LEASE_EVENTS_GENERATOR_DRY_RUN;
  });

  it("is off unless ENABLED is exactly \"true\"; the dry run wins", () => {
    expect(generatorMode({})).toBe("off");
    expect(generatorMode({ LEASE_EVENTS_GENERATOR_ENABLED: "TRUE" })).toBe("off");
    expect(generatorMode({ LEASE_EVENTS_GENERATOR_ENABLED: "true" })).toBe("live");
    expect(generatorMode({ LEASE_EVENTS_GENERATOR_DRY_RUN: "true", LEASE_EVENTS_GENERATOR_ENABLED: "true" })).toBe("dry-run");
  });

  it("off, the timer touches no database", async () => {
    await leaseEventsGeneratorTimer({} as Timer, ctx);
    expect(db.createServiceRequestConnection).not.toHaveBeenCalled();
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});

describe("runLeaseEventsGenerator", () => {
  const rows = [
    { BuildingId: 3, Expiry: "2027-06-30", LegalName: "Option Co", OptionNoticeMonths: 6, OptionPeriods: "1 x 5 years", TenantId: 7 },
    { BuildingId: 3, Expiry: "2027-01-31", LegalName: "Renew Co", OptionNoticeMonths: null, OptionPeriods: "Nil", TenantId: 8 },
  ];
  beforeEach(() => {
    jest.clearAllMocks();
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (sql.includes("FROM dbo.Tenants t\n  WHERE t.Status IN")) return rows;
      if (sql.includes("FROM dbo.LeaseEvents e")) return [];
      return [];
    });
  });

  it("selects positively: live, not archived, not test, with an expiry", async () => {
    await runLeaseEventsGenerator({ connection: {} as never, dryRun: true, log: jest.fn(), today: TODAY, warn: jest.fn() });
    const select = db.executeQuery.mock.calls[0][1] as string;
    expect(select).toMatch(/t\.Status IN \('current', 'holdover'\) AND t\.ArchivedAt IS NULL AND t\.IsTest = 0 AND t\.Expiry IS NOT NULL/);
  });

  it("a dry run logs and counts what it would do and writes nothing", async () => {
    const log = jest.fn();
    const report = await runLeaseEventsGenerator({ connection: {} as never, dryRun: true, log, today: TODAY, warn: jest.fn() });
    expect(report.written).toMatchObject({ open_option: 1, refer_renewal: 1 });
    expect(db.executeQuery.mock.calls.every((call) => /^\s*SELECT/.test(call[1] as string))).toBe(true);
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(escalation.raise).not.toHaveBeenCalled();
    expect(log.mock.calls.map((c) => c[0]).join("\n")).toMatch(/would open the option event for Option Co[\s\S]*would refer Renew Co/);
  });

  it("a live run writes each action in its own transaction, ledgered as the system, and refers the renewal to the directors", async () => {
    const report = await runLeaseEventsGenerator({ connection: {} as never, dryRun: false, log: jest.fn(), today: TODAY, warn: jest.fn() });
    expect(report.errors).toEqual([]);
    expect(db.beginTransaction).toHaveBeenCalledTimes(2);
    expect(db.commitTransaction).toHaveBeenCalledTimes(2);
    expect(ledgerInserts(db.executeQuery).map((row) => [row.action, row.actorKind, row.actorName])).toEqual([
      ["lease_event.open", "system", "leaseEventsGeneratorTimer"],
      ["lease_event.renewal_referred", "system", "leaseEventsGeneratorTimer"],
    ]);
    expect(escalation.raise).toHaveBeenCalledTimes(1);
    expect(escalation.raise).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ policyKey: "lease.renewal", subjectType: "lease_event" }));
  });

  it("stops at the cap, soonest first, and says how many wait", async () => {
    const report = await runLeaseEventsGenerator({ connection: {} as never, dryRun: true, log: jest.fn(), maxActions: 1, today: TODAY, warn: jest.fn() });
    expect(report.actions.map((a) => a.kind)).toEqual(["open_option"]);
    expect(report.deferred).toBe(1);
  });
});
