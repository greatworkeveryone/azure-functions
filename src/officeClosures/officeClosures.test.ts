/// <reference types="jest" />
jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createServiceRequestConnection: jest.fn(),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));

import type { Connection } from "tedious";
import { AppRole } from "../auth";
import { ledgerInserts } from "../__tests__/fixtures/ledgerCalls";
import { addBusinessHours, holidaysFromEnv, setLoadedClosureDays } from "../escalation/businessTime";
import { buildCalendar, clearOfficeCalendarCache, expandClosure, loadBusinessCalendar, loadOfficeCalendar } from "./calendar";
import { archiveClosure, EDIT_OFFICE_CLOSURES_ROLES, parseClosureInput, saveClosure } from "./closures";
import { officeStatus } from "./status";

const db = require("../db") as { executeQuery: jest.Mock };
const conn = {} as Connection;
const actor = { kind: "user", name: "Simone", role: "facilities_manager", userId: 7 } as const;
const darwin = (iso: string) => new Date(`${iso}+09:30`);

beforeEach(() => {
  db.executeQuery.mockReset();
  clearOfficeCalendarCache();
});

describe("expanding and building the calendar", () => {
  it("lists every day of a range, inclusive", () => {
    expect(expandClosure("2026-12-24", "2026-12-28")).toEqual(["2026-12-24", "2026-12-25", "2026-12-26", "2026-12-27", "2026-12-28"]);
    expect(expandClosure("2026-12-28", "2026-12-24")).toEqual([]);
  });
  it("unions closures with ESCALATION_HOLIDAYS", () => {
    const cal = buildCalendar([{ endsOn: "2026-12-30", label: "Shutdown", startsOn: "2026-12-29" }], { ESCALATION_HOLIDAYS: "2026-06-01" } as NodeJS.ProcessEnv);
    expect([...cal.holidays].sort()).toEqual(["2026-06-01", "2026-12-29", "2026-12-30"]);
  });
});

describe("loading from the database", () => {
  const rows = [{ EndsOn: new Date("2026-12-31T00:00:00Z"), Label: "Christmas shutdown", StartsOn: new Date("2026-12-24T00:00:00Z") }];

  it("reads active closures once, caches them, and registers them for default calendars", async () => {
    db.executeQuery.mockResolvedValue(rows);
    const env = { ESCALATION_HOLIDAYS: "2026-06-01" } as NodeJS.ProcessEnv;
    const days = await loadBusinessCalendar(conn, env);
    await loadBusinessCalendar(conn, env);
    expect(db.executeQuery).toHaveBeenCalledTimes(1);
    expect(db.executeQuery.mock.calls[0][1]).toMatch(/ArchivedAt IS NULL/);
    expect(days.has("2026-12-28")).toBe(true);
    expect(days.has("2026-06-01")).toBe(true);
    expect(holidaysFromEnv({} as NodeJS.ProcessEnv).has("2026-12-28")).toBe(true);
  });

  it("falls back to the env holidays when the table can't be read", async () => {
    db.executeQuery.mockRejectedValue(new Error("Invalid object name 'dbo.OfficeClosures'"));
    const cal = await loadOfficeCalendar(conn, { ESCALATION_HOLIDAYS: "2026-06-01" } as NodeJS.ProcessEnv);
    expect([...cal.holidays]).toEqual(["2026-06-01"]);
  });

  it("makes business-time deadlines skip a closure", async () => {
    db.executeQuery.mockResolvedValue(rows);
    const holidays = await loadBusinessCalendar(conn, {} as NodeJS.ProcessEnv);
    // Wed 23 Dec 2026 16:00 + 1h: the closure covers Thu 24 to Thu 31 Dec; weekends skip; next opening is Fri 1 Jan.
    const due = addBusinessHours(darwin("2026-12-23T16:00:00"), 1, holidays);
    expect(due.toISOString()).toBe(darwin("2027-01-01T09:00:00").toISOString());
  });

  afterAll(() => setLoadedClosureDays(new Set()));
});

describe("officeStatus", () => {
  const cal = buildCalendar([{ endsOn: "2026-12-31", label: "Christmas shutdown", startsOn: "2026-12-24" }], {} as NodeJS.ProcessEnv);
  it("is open inside hours on a business day", () => {
    expect(officeStatus(darwin("2026-11-04T10:00:00"), cal)).toEqual({ closureLabel: null, open: true, reopensAt: null });
  });
  it("is closed after hours and reopens next morning", () => {
    const s = officeStatus(darwin("2026-11-04T17:00:00"), cal);
    expect(s).toEqual({ closureLabel: null, open: false, reopensAt: darwin("2026-11-05T08:30:00").toISOString() });
  });
  it("is closed before opening and reopens the same morning", () => {
    expect(officeStatus(darwin("2026-11-04T07:00:00"), cal).reopensAt).toBe(darwin("2026-11-04T08:30:00").toISOString());
  });
  it("is closed at the weekend and reopens Monday", () => {
    expect(officeStatus(darwin("2026-11-07T12:00:00"), cal)).toMatchObject({ open: false, reopensAt: darwin("2026-11-09T08:30:00").toISOString() });
  });
  it("names the closure and reopens after it", () => {
    expect(officeStatus(darwin("2026-12-25T11:00:00"), cal)).toEqual({ closureLabel: "Christmas shutdown", open: false, reopensAt: darwin("2027-01-01T08:30:00").toISOString() });
  });
  it("is closed with no label on a holiday that comes from the env", () => {
    const env = buildCalendar([], { ESCALATION_HOLIDAYS: "2026-11-04" } as NodeJS.ProcessEnv);
    expect(officeStatus(darwin("2026-11-04T10:00:00"), env)).toMatchObject({ closureLabel: null, open: false, reopensAt: darwin("2026-11-05T08:30:00").toISOString() });
  });
  it("closes at 16:30 sharp", () => {
    expect(officeStatus(darwin("2026-11-04T16:29:00"), cal).open).toBe(true);
    expect(officeStatus(darwin("2026-11-04T16:30:00"), cal).open).toBe(false);
  });
});

describe("input", () => {
  const good = { endsOn: "2026-12-31", kind: "shutdown", label: " Christmas shutdown ", startsOn: "2026-12-24" };
  it("accepts a range and trims the label", () => {
    expect(parseClosureInput(good)).toMatchObject({ ok: true, value: { closureId: null, label: "Christmas shutdown" } });
  });
  it.each([
    [{ ...good, endsOn: "2026-12-01" }, /before/],
    [{ ...good, startsOn: "2026-02-30" }, /dates/],
    [{ ...good, label: "  " }, /label/],
    [{ ...good, kind: "party" }, /kind/],
    [{ ...good, endsOn: "2028-01-01" }, /longer than/],
    [{ ...good, closureId: 4 }, /rowVersion/],
  ])("refuses %j", (body, message) => {
    expect(parseClosureInput(body)).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(message) });
  });
  it("is edited by admin, director and the facilities manager", () => {
    expect([...EDIT_OFFICE_CLOSURES_ROLES]).toEqual([AppRole.ADMIN, AppRole.DIRECTOR, AppRole.FACILITIES_APPROVAL]);
  });
});

describe("writes", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    ArchivedAt: null, ClosureId: 3, EndsOn: new Date("2026-12-31T00:00:00Z"), Kind: "shutdown", Label: "Christmas shutdown", RowVersion: Buffer.from("v1"),
    StartsOn: new Date("2026-12-24T00:00:00Z"), UpdatedAt: new Date(), UpdatedBy: "Pat", ...over,
  });
  const input = { closureId: 3, endsOn: "2026-12-31", kind: "shutdown" as const, label: "Shutdown", rowVersion: Buffer.from("v1").toString("base64"), startsOn: "2026-12-24" };

  it("ledgers a create", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => (/INSERT INTO dbo\.OfficeClosures/.test(sql) ? [{ ClosureId: 3 }] : /SELECT ClosureId/.test(sql) ? [row()] : []));
    const r = await saveClosure(conn, { actor, caller: "Simone", closure: { ...input, closureId: null, rowVersion: null } });
    expect(r).toMatchObject({ ok: true, value: { created: true } });
    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ action: "settings.office_closure_create" });
  });

  it("updates with the rowVersion it read and ledgers before and after", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => (/^\s*UPDATE dbo\.OfficeClosures/.test(sql) ? [{ ClosureId: 3 }] : /SELECT ClosureId/.test(sql) ? [row()] : []));
    const r = await saveClosure(conn, { actor, caller: "Simone", closure: input });
    expect(r).toMatchObject({ ok: true, value: { created: false } });
    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ action: "settings.office_closure_update" });
  });

  it("answers 409 for a stale rowVersion, without writing", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => (/SELECT ClosureId/.test(sql) ? [row({ RowVersion: Buffer.from("v2") })] : []));
    const r = await saveClosure(conn, { actor, caller: "Simone", closure: input });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(db.executeQuery.mock.calls.some((c) => /^\s*UPDATE/.test(c[1]))).toBe(false);
  });

  it("answers 409 when the guarded UPDATE matches nothing (changed between read and write)", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => (/SELECT ClosureId/.test(sql) ? [row()] : []));
    expect(await saveClosure(conn, { actor, caller: "Simone", closure: input })).toMatchObject({ ok: false, status: 409 });
  });

  it("archives, never deletes, and ledgers", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => (/SELECT ClosureId/.test(sql) ? [row()] : []));
    const r = await archiveClosure(conn, { actor, caller: "Simone", closureId: 3, rowVersion: input.rowVersion });
    expect(r.ok).toBe(true);
    const sqls = db.executeQuery.mock.calls.map((c) => String(c[1]));
    expect(sqls.some((q) => /SET ArchivedAt = SYSUTCDATETIME\(\)/.test(q))).toBe(true);
    expect(sqls.some((q) => /\bDELETE\b/i.test(q))).toBe(false);
    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ action: "settings.office_closure_archive" });
  });

  it("archiving twice is a no-op", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => (/SELECT ClosureId/.test(sql) ? [row({ ArchivedAt: new Date() })] : []));
    expect((await archiveClosure(conn, { actor, caller: "S", closureId: 3, rowVersion: "x" })).ok).toBe(true);
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
  });
});
