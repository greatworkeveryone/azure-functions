/// <reference types="jest" />
import { TYPES } from "tedious";
import type { Connection } from "tedious";
import { LedgerValidationError, newCorrelationId, record } from "./index";
import type { LedgerEntryInput } from "./types";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));

const db = require("../db") as { executeQuery: jest.Mock };
const tx = { id: "the caller's transaction" } as unknown as Connection;

const fay = { kind: "user" as const, name: "Fay Staff", role: "facilities", userId: 11 };
const mo = { name: "Mo Manager", role: "facilities_manager", userId: 12 };

function entry(overrides: Partial<LedgerEntryInput> = {}): LedgerEntryInput {
  return {
    action: "user.role_change",
    actor: fay,
    after: { role: "director" },
    before: { role: "user" },
    subject: { id: 7, type: "app_user" },
    ...overrides,
  };
}

type Param = { name: string; options?: { precision?: number; scale?: number }; type: unknown; value: unknown };

function sentParams(): Record<string, Param> {
  const params = db.executeQuery.mock.calls[0][2] as Param[];
  return Object.fromEntries(params.map((p) => [p.name, p]));
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockResolvedValue([]);
  delete process.env.APP_VERSION;
});

describe("record", () => {
  it("appends one parameterised row through the caller's own connection", async () => {
    await record(tx, entry());

    expect(db.executeQuery).toHaveBeenCalledTimes(1);
    const [conn, sql] = db.executeQuery.mock.calls[0];
    expect(conn).toBe(tx);
    expect(sql).toMatch(/^INSERT INTO dbo\.DecisionLedger/);
    // Values travel as parameters, never as text in the statement.
    expect(sql).not.toMatch(/Fay Staff|user\.role_change|director/);
  });

  it("never begins, commits or rolls back: the caller owns the transaction", async () => {
    const connection = { beginTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn() };
    await record(connection as unknown as Connection, entry());
    expect(connection.beginTransaction).not.toHaveBeenCalled();
    expect(connection.commitTransaction).not.toHaveBeenCalled();
    expect(connection.rollbackTransaction).not.toHaveBeenCalled();
  });

  it("maps the entry onto the columns", async () => {
    await record(
      tx,
      entry({
        action: "approval_limit.change",
        buildingId: 5,
        jobId: 99,
        reason: "  Raised for the new facilities manager  ",
        ruleApplied: "manual",
        subject: { id: "accounts_manager", type: "approval_limit" },
        tenantId: 42,
      }),
    );

    const p = sentParams();
    expect(p.Action.value).toBe("approval_limit.change");
    expect(p.SubjectType.value).toBe("approval_limit");
    expect(p.SubjectId.value).toBe("accounts_manager");
    expect([p.TenantId.value, p.JobId.value, p.BuildingId.value]).toEqual([42, 99, 5]);
    expect(p.ActorUserId.value).toBe(11);
    expect(p.ActorName.value).toBe("Fay Staff");
    expect(p.ActorRole.value).toBe("facilities");
    expect(p.ActorKind.value).toBe("user");
    expect(p.Reason.value).toBe("Raised for the new facilities manager");
    expect(p.RuleApplied.value).toBe("manual");
  });

  it("writes a numeric subject id as text", async () => {
    await record(tx, entry({ subject: { id: 7, type: "app_user" } }));
    expect(sentParams().SubjectId).toMatchObject({ type: TYPES.NVarChar, value: "7" });
  });

  it("records a system actor without a user id or role", async () => {
    await record(
      tx,
      entry({
        action: "schedule.recompute_next_review",
        actor: { kind: "system", name: "tenancyReviewScheduleTimer" },
        subject: { id: 3, type: "tenancy" },
      }),
    );

    const p = sentParams();
    expect(p.ActorKind.value).toBe("system");
    expect(p.ActorName.value).toBe("tenancyReviewScheduleTimer");
    expect(p.ActorUserId.value).toBeNull();
    expect(p.ActorRole.value).toBeNull();
  });

  it("records the person the decision is attributed to", async () => {
    await record(
      tx,
      entry({
        action: "quote.approve_attributed",
        attributedTo: mo,
        subject: { id: 123, type: "quote" },
      }),
    );

    const p = sentParams();
    expect(p.AttributedUserId.value).toBe(12);
    expect(p.AttributedName.value).toBe("Mo Manager");
    expect(p.AttributedRole.value).toBe("facilities_manager");
  });

  it("leaves the attribution columns NULL when nobody is named", async () => {
    await record(tx, entry());
    const p = sentParams();
    expect([p.AttributedUserId.value, p.AttributedName.value, p.AttributedRole.value]).toEqual([null, null, null]);
  });

  it("keeps an attributed person without a Floorplan account (no user id)", async () => {
    await record(
      tx,
      entry({ action: "quote.approve_attributed", attributedTo: { ...mo, userId: null }, subject: { id: 1, type: "quote" } }),
    );
    const p = sentParams();
    expect(p.AttributedUserId.value).toBeNull();
    expect(p.AttributedName.value).toBe("Mo Manager");
  });

  it("takes IsException from the registry, not from the caller", async () => {
    await record(tx, entry({ action: "user.role_change" }));
    expect(sentParams().IsException).toMatchObject({ type: TYPES.Bit, value: true });

    db.executeQuery.mockClear();
    await record(tx, entry({ action: "schedule.manual_edit", subject: { id: "s1", type: "rate_step" } }));
    expect(sentParams().IsException.value).toBe(false);
  });

  it("stores snapshots as JSON text, and NULL when there is nothing to store", async () => {
    await record(tx, entry({ computed: { rent: 1200.5 }, after: { role: "director" }, before: undefined }));

    const p = sentParams();
    expect(JSON.parse(p.After.value as string)).toEqual({ role: "director" });
    expect(JSON.parse(p.Computed.value as string)).toEqual({ rent: 1200.5 });
    expect(p.Before.value).toBeNull();
  });

  it("treats a null snapshot as nothing to store", async () => {
    await record(tx, entry({ before: null }));
    expect(sentParams().Before.value).toBeNull();
  });

  it("wraps a bare value so the column's ISJSON check (objects and arrays only) accepts it", async () => {
    await record(tx, entry({ after: "director", before: 42, computed: true }));

    const p = sentParams();
    expect(JSON.parse(p.After.value as string)).toEqual({ value: "director" });
    expect(JSON.parse(p.Before.value as string)).toEqual({ value: 42 });
    expect(JSON.parse(p.Computed.value as string)).toEqual({ value: true });
  });

  it("keeps arrays as arrays", async () => {
    await record(tx, entry({ after: [1, 2] }));
    expect(sentParams().After.value).toBe("[1,2]");
  });

  it("sends the dollar impact as DECIMAL(14,2), or tedious would drop the cents", async () => {
    await record(tx, entry({ financialImpact: 1234.56 }));
    expect(sentParams().FinancialImpact).toMatchObject({
      options: { precision: 14, scale: 2 },
      type: TYPES.Decimal,
      value: 1234.56,
    });
  });

  it("sends a missing impact as NULL, and zero as zero", async () => {
    await record(tx, entry());
    expect(sentParams().FinancialImpact.value).toBeNull();

    db.executeQuery.mockClear();
    await record(tx, entry({ financialImpact: 0 }));
    expect(sentParams().FinancialImpact.value).toBe(0);
  });

  it("gives each entry a fresh GUID correlation id unless one is supplied", async () => {
    await record(tx, entry());
    const generated = sentParams().CorrelationId;
    expect(generated.type).toBe(TYPES.UniqueIdentifier);
    expect(generated.value).toMatch(GUID);

    db.executeQuery.mockClear();
    const shared = newCorrelationId();
    await record(tx, entry({ correlationId: shared }));
    expect(sentParams().CorrelationId.value).toBe(shared);
  });

  it("takes AppVersion from the environment, clipped to the column", async () => {
    await record(tx, entry());
    expect(sentParams().AppVersion.value).toBeNull();

    db.executeQuery.mockClear();
    process.env.APP_VERSION = "2026.10.13+" + "x".repeat(60);
    await record(tx, entry());
    expect((sentParams().AppVersion.value as string).length).toBe(40);

    db.executeQuery.mockClear();
    process.env.APP_VERSION = "1.4.2";
    await record(tx, entry());
    expect(sentParams().AppVersion.value).toBe("1.4.2");
  });

  it("validates first: a refused entry sends no SQL", async () => {
    await expect(record(tx, entry({ action: "nope" as never }))).rejects.toThrow(LedgerValidationError);
    await expect(
      record(tx, entry({ action: "quote.approve_attributed", subject: { id: 1, type: "quote" } })),
    ).rejects.toThrow(/attributedTo/);
    await expect(
      record(tx, entry({ action: "quote.attribution_disputed", reason: " ", subject: { id: 1, type: "quote" } })),
    ).rejects.toThrow(/reason is required/);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("lets a failed INSERT reject, so the caller's decision fails with it", async () => {
    db.executeQuery.mockRejectedValue(new Error("Invalid object name 'dbo.DecisionLedger'."));
    await expect(record(tx, entry())).rejects.toThrow(/Invalid object name/);
  });
});
