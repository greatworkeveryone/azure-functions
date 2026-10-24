/// <reference types="jest" />
// The one-off option backfill (WP32): what it fills, what it lists for accounts,
// that a dry run writes nothing, and that it never overwrites a recorded value.
import { ledgerInserts } from "./fixtures/ledgerCalls";

jest.mock("../db", () => ({
  beginTransaction: jest.fn(),
  commitTransaction: jest.fn(),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn(),
}));

import { planOptionBackfill, runOptionBackfill, type BackfillTenancy } from "../leaseEvents/optionBackfill";

const db = jest.requireMock("../db") as Record<string, jest.Mock>;
const t = (tenantId: number, optionPeriods: string | null, recorded = false): BackfillTenancy => ({
  buildingId: 3,
  buildingName: "Tower A",
  name: `Tenant ${tenantId}`,
  optionPeriods,
  recorded,
  tenantId,
});

describe("planOptionBackfill", () => {
  it("fills what parses, lists what doesn't, and leaves blank, Nil and recorded rows alone", () => {
    const plan = planOptionBackfill([t(1, "2 x 5 years"), t(2, "5 + 5"), t(3, "Nil"), t(4, null), t(5, "Option at landlord's discretion"), t(6, "1 x 3 years", true), t(7, "N/A")]);
    expect(plan.fill.map((row) => [row.tenantId, row.count, row.termMonths])).toEqual([
      [1, 2, 60],
      [2, 2, 60],
    ]);
    expect(plan.unparseable.map((row) => row.tenantId)).toEqual([5]);
    expect([plan.none, plan.recorded]).toEqual([3, 1]);
  });
});

describe("runOptionBackfill", () => {
  const rows = [
    { BuildingId: 3, BuildingName: "Tower A", LegalName: "Acme", OptionPeriods: "2 x 5 years", OptionTermMonths: null, OptionsRemaining: null, OptionsTotal: null, TenantId: 1 },
    { BuildingId: 3, BuildingName: "Tower A", LegalName: "Odd", OptionPeriods: "Ask the landlord", OptionTermMonths: null, OptionsRemaining: null, OptionsTotal: null, TenantId: 2 },
  ];
  beforeEach(() => {
    jest.clearAllMocks();
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (sql.includes("SELECT t.TenantId")) return rows;
      if (sql.includes("UPDATE dbo.Tenants")) return [{ TenantId: 1 }];
      return [];
    });
  });

  it("a dry run lists and writes nothing", async () => {
    const log = jest.fn();
    const report = await runOptionBackfill({} as never, { apply: false, log });
    expect(report.plan.fill).toHaveLength(1);
    expect(db.executeQuery).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.map((c) => c[0]).join("\n")).toMatch(/unparseable, for accounts to fix \(nothing written\): 1\n\s+2\s+Odd \(Tower A\): "Ask the landlord"/);
  });

  it("--apply fills only columns still NULL, in a transaction, ledgered", async () => {
    const report = await runOptionBackfill({} as never, { apply: true, log: jest.fn() });
    expect(report.filled).toBe(1);
    const update = db.executeQuery.mock.calls.find((call) => String(call[1]).includes("UPDATE dbo.Tenants"));
    expect(update?.[1]).toMatch(/WHERE TenantId = @TenantId AND OptionsTotal IS NULL AND OptionsRemaining IS NULL AND OptionTermMonths IS NULL/);
    expect(db.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    expect(ledgerInserts(db.executeQuery).map((row) => [row.action, row.actorName, row.ruleApplied])).toEqual([
      ["schedule.terms_edit", "backfill-lease-options", "option_backfill_from_text"],
    ]);
  });
});
