/// <reference types="jest" />
// WP32: a live generator run lapses an option whose deadline passed with no
// notice, ledgered as the system, and raises lease.option_lapsed (attention, to
// the directors) through the escalation engine; a dry run does neither.
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

import { runLeaseEventsGenerator } from "../leaseEvents/generator";

const db = jest.requireMock("../db") as Record<string, jest.Mock>;
const escalation = jest.requireMock("../escalation") as { raise: jest.Mock };

const TENANCY = { BuildingId: 3, Expiry: "2027-04-30", LegalName: "Lapse Co", OptionNoticeMonths: 6, OptionPeriods: "1 x 5 years", TenantId: 7 };
const OPEN_EVENT = { DeadlineOn: "2026-10-31", LeaseEventId: "ev-9", LeaseExpiry: "2027-04-30", State: "window_open", TenantId: 7, Type: "option_exercise", WindowOpensOn: "2026-04-30" };

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    if (sql.includes("FROM dbo.Tenants t\n  WHERE t.Status IN")) return [TENANCY];
    if (sql.includes("FROM dbo.LeaseEvents e")) return [OPEN_EVENT];
    if (sql.includes("UPDATE dbo.LeaseEvents")) return [{ LeaseEventId: "ev-9" }];
    return [];
  });
});

it("lapses the option the day after its deadline and refers it to the directors", async () => {
  const report = await runLeaseEventsGenerator({ connection: {} as never, dryRun: false, log: jest.fn(), today: "2026-11-01", warn: jest.fn() });
  expect(report.written.lapse).toBe(1);
  const update = db.executeQuery.mock.calls.find((call) => String(call[1]).includes("UPDATE dbo.LeaseEvents"));
  expect(update?.[1]).toMatch(/Outcome = 'lapsed'/);
  expect(ledgerInserts(db.executeQuery).map((row) => [row.action, row.actorKind])).toEqual([["lease_event.lapsed", "system"]]);
  expect(escalation.raise).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ policyKey: "lease.option_lapsed", subjectId: "ev-9", subjectType: "lease_event" }),
  );
});

it("does nothing on the deadline itself, and a dry run writes and raises nothing", async () => {
  const onTheDay = await runLeaseEventsGenerator({ connection: {} as never, dryRun: false, log: jest.fn(), today: "2026-10-31", warn: jest.fn() });
  expect(onTheDay.written.lapse).toBe(0);
  jest.clearAllMocks();
  const dry = await runLeaseEventsGenerator({ connection: {} as never, dryRun: true, log: jest.fn(), today: "2026-11-01", warn: jest.fn() });
  expect(dry.written.lapse).toBe(1);
  expect(db.beginTransaction).not.toHaveBeenCalled();
  expect(escalation.raise).not.toHaveBeenCalled();
});
