/// <reference types="jest" />

jest.mock("./db", () => ({ executeQuery: jest.fn() }));
jest.mock("./ledger", () => ({ record: jest.fn().mockResolvedValue(undefined) }));

import { changeControl, isMyobController, MyobControlsError, setPaused } from "./myob-controls-admin";
import type { LedgerActor } from "./ledger";

const { executeQuery } = require("./db") as { executeQuery: jest.Mock };
const { record } = require("./ledger") as { record: jest.Mock };

const CF = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const OTHER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const JOHANNE: LedgerActor = { kind: "user", name: "Johanne", role: "cfo", userId: 12 };
const V1 = Buffer.from("0000000000000001", "hex");
const V2 = Buffer.from("0000000000000002", "hex");
const tx = {} as never;
const original = process.env.MYOB_COMPANY_FILE_ID;

const row = (over: Record<string, unknown> = {}) => ({
  CompanyFileId: CF,
  DailyCap: 0,
  DryRun: true,
  Enabled: false,
  Note: null,
  Operation: "orders.create",
  PausedAll: false,
  RequireReview: true,
  RowVersion: V1,
  UpdatedAt: new Date("2026-10-14T00:00:00Z"),
  UpdatedBy: null,
  ...over,
});

interface World {
  authFile?: string | null;
  fileRegistered?: boolean;
  rows?: ReturnType<typeof row>[];
}

function world({ authFile = null, fileRegistered = true, rows = [row()] }: World) {
  let current = rows.map((r) => ({ ...r }));
  executeQuery.mockImplementation(async (_c: unknown, sql: string, params: { name: string; value: unknown }[] = []) => {
    const p = Object.fromEntries(params.map((x) => [x.name, x.value]));
    if (/FROM dbo\.MyobAuth\b/.test(sql)) return authFile ? [{ BusinessId: authFile }] : [];
    if (/SELECT 1 AS Registered FROM dbo\.MyobCompanyFiles/.test(sql)) return fileRegistered ? [{ Registered: 1 }] : [];
    if (/INSERT INTO dbo\.MyobCompanyFiles/.test(sql)) return [];
    if (/INSERT INTO dbo\.MyobControls/.test(sql)) {
      current = current.concat([row({ Operation: p.Operation, RowVersion: V1 })]);
      return [];
    }
    if (/UPDATE dbo\.MyobControls/.test(sql) && /PausedAll = @Paused/.test(sql)) {
      const hits = current.filter((r) => (p.CompanyFileId ? r.CompanyFileId === p.CompanyFileId : true) && r.PausedAll !== p.Paused);
      hits.forEach((r) => (r.PausedAll = p.Paused as boolean));
      return [...new Set(hits.map((r) => r.CompanyFileId))].map((CompanyFileId) => ({ CompanyFileId }));
    }
    if (/UPDATE dbo\.MyobControls/.test(sql)) {
      const target = current.find((r) => r.CompanyFileId === p.CompanyFileId && r.Operation === p.Operation)!;
      Object.assign(target, { DailyCap: p.DailyCap, DryRun: p.DryRun, Enabled: p.Enabled, Note: p.Note, RequireReview: p.RequireReview, RowVersion: V2, UpdatedBy: p.UpdatedBy });
      return [target];
    }
    if (/FROM dbo\.MyobControls/.test(sql)) {
      return current.filter((r) => r.CompanyFileId === p.CompanyFileId && (!p.Operation || r.Operation === p.Operation));
    }
    return [];
  });
  return () => current;
}

const change = (over: Partial<Parameters<typeof changeControl>[2]> = {}) =>
  changeControl(tx, JOHANNE, {
    changes: { enabled: true },
    companyFileId: CF,
    expectedRowVersion: V1.toString("base64"),
    note: "Demo file: orders on for the lab",
    operation: "orders.create",
    ...over,
  });

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.MYOB_COMPANY_FILE_ID;
});

afterAll(() => {
  if (original === undefined) delete process.env.MYOB_COMPANY_FILE_ID;
  else process.env.MYOB_COMPANY_FILE_ID = original;
});

describe("isMyobController", () => {
  it("is the cfo role only: admin and director cannot change MYOB controls", () => {
    expect(isMyobController(["cfo"])).toBe(true);
    expect(isMyobController(["admin"])).toBe(false);
    expect(isMyobController(["director"])).toBe(false);
    expect(isMyobController(["admin", "director", "accounts_manager"])).toBe(false);
  });
});

describe("changeControl", () => {
  it("applies the change and ledgers myob.control_change with before, after and the note", async () => {
    world({});

    const result = await change();

    expect(result.changed).toBe(true);
    expect(result.row).toMatchObject({ enabled: true, operation: "orders.create", rowVersion: V2.toString("base64") });
    expect(record).toHaveBeenCalledWith(tx, expect.objectContaining({
      action: "myob.control_change",
      actor: JOHANNE,
      after: expect.objectContaining({ enabled: true }),
      before: expect.objectContaining({ enabled: false }),
      reason: "Demo file: orders on for the lab",
      subject: { id: `${CF}:orders.create`, type: "myob_control" },
    }));
  });

  it("refuses to switch bills.create on while bills are disabled in code (until J3 removes payments.ts's direct MYOB calls)", async () => {
    world({});

    await expect(change({ changes: { enabled: true }, operation: "bills.create" })).rejects.toMatchObject({
      message: expect.stringContaining("Bills stay off"),
      status: 409,
    });
    expect(executeQuery).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("409s on a stale version, writing nothing", async () => {
    world({});

    await expect(change({ expectedRowVersion: V2.toString("base64") })).rejects.toMatchObject({ status: 409 });
    expect(executeQuery.mock.calls.some((c: unknown[]) => /UPDATE dbo\.MyobControls/.test(String(c[1])))).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });

  it("requires a version for a row that already exists", async () => {
    world({});
    await expect(change({ expectedRowVersion: null })).rejects.toMatchObject({ status: 409 });
  });

  it("changes nothing, and ledgers nothing, when the values are already set", async () => {
    world({ rows: [row({ Enabled: true })] });

    const result = await change();

    expect(result.changed).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });

  it("sets up the configured file's seven controls (all off) on first use, then applies the change", async () => {
    process.env.MYOB_COMPANY_FILE_ID = CF;
    const state = world({ fileRegistered: false, rows: [] });

    const result = await change({ expectedRowVersion: null });

    expect(result).toMatchObject({ changed: true, seeded: true });
    expect(state().map((r) => r.Operation).sort()).toEqual(
      ["bills.create", "lab.enabled", "orders.create", "orders.update", "purchases.read", "quotes.create", "quotes.update"],
    );
    expect(executeQuery.mock.calls.some((c: unknown[]) => /INSERT INTO dbo\.MyobCompanyFiles/.test(String(c[1])))).toBe(true);
    expect(record.mock.calls[0][1].computed).toEqual({ seeded: true });
  });

  it("sets up the linked file when none is configured", async () => {
    world({ authFile: CF, fileRegistered: false, rows: [] });
    await expect(change({ expectedRowVersion: null })).resolves.toMatchObject({ seeded: true });
  });

  it("refuses (404) to set up any other file: registering files is a separate step", async () => {
    process.env.MYOB_COMPANY_FILE_ID = CF;
    world({ fileRegistered: false, rows: [] });

    await expect(change({ companyFileId: OTHER, expectedRowVersion: null })).rejects.toMatchObject({ status: 404 });
    expect(record).not.toHaveBeenCalled();
  });

  it("is a MyobControlsError for the handler to map", async () => {
    world({});
    await expect(change({ expectedRowVersion: V2.toString("base64") })).rejects.toBeInstanceOf(MyobControlsError);
  });
});

describe("setPaused", () => {
  it("pauses every file when none is named, ledgering one row per file it changed", async () => {
    world({ rows: [row(), row({ Operation: "purchases.read" }), row({ CompanyFileId: OTHER })] });

    const result = await setPaused(tx, JOHANNE, { companyFileId: null, note: "Stop: checking a duplicate", paused: true });

    expect(result.files.sort()).toEqual([CF, OTHER].sort());
    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls[0][1]).toMatchObject({
      action: "myob.control_change",
      after: { pausedAll: true },
      before: { pausedAll: false },
      reason: "Stop: checking a duplicate",
      ruleApplied: "pause",
    });
  });

  it("resumes one file and ledgers it as resume; a file already in that state is left alone", async () => {
    world({ rows: [row({ PausedAll: true }), row({ CompanyFileId: OTHER, PausedAll: false })] });

    const result = await setPaused(tx, JOHANNE, { companyFileId: CF, note: "Checked", paused: false });

    expect(result.files).toEqual([CF]);
    expect(record.mock.calls[0][1]).toMatchObject({ ruleApplied: "resume", subject: { id: `${CF}:*`, type: "myob_control" } });
  });
});

describe("decision history", () => {
  it("lets the CFO read the history of MYOB controls and the link", () => {
    const { historyReadRoles } = jest.requireActual("./ledger/historyRoles") as typeof import("./ledger/historyRoles");
    expect(historyReadRoles("myob_control")).toEqual(["cfo"]);
    expect(historyReadRoles("myob_link")).toEqual(["cfo"]);
  });
});
