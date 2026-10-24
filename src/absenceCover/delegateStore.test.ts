/// <reference types="jest" />
import { TYPES } from "tedious";
import { archiveDelegateRow, getDelegate, insertDelegate, listDelegatesOn, listUpcomingDelegates, toDelegateRow } from "./delegateStore";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));
const db = jest.requireMock("../db") as { executeQuery: jest.Mock };
const conn = {} as never;

const VERSION = Buffer.from([0, 0, 0, 0, 0, 0, 0, 7]);
const RAW = { ArchivedAt: null, CoverDelegateId: 5, CreatedAt: new Date("2026-10-20T00:00:00Z"), CreatedBy: "Fay", DelegateName: "Sam", DelegateUserId: 7, FromDate: "2026-10-26", LeaveRequestId: null, RowVersion: VERSION, ToDate: "2026-10-30", UserId: 1, UserName: "Fay" };
const sql = (): string => String(db.executeQuery.mock.calls[0][1]);
const params = (): Record<string, { type: unknown; value: unknown }> => Object.fromEntries((db.executeQuery.mock.calls[0][2] as { name: string; type: unknown; value: unknown }[]).map((param) => [param.name, param]));

beforeEach(() => db.executeQuery.mockReset());

describe("delegateStore", () => {
  it("maps a row with dates as DD-free ISO text and the version as base64", () => {
    expect(toDelegateRow(RAW)).toMatchObject({ archivedAt: null, coverDelegateId: 5, delegateName: "Sam", delegateUserId: 7, fromDate: "2026-10-26", leaveRequestId: null, rowVersion: VERSION.toString("base64"), toDate: "2026-10-30", userId: 1 });
    expect(toDelegateRow({ ...RAW, ArchivedAt: new Date(), LeaveRequestId: 4 })).toMatchObject({ leaveRequestId: 4 });
  });

  it("lists the nominations in force on a date, never an archived one", async () => {
    db.executeQuery.mockResolvedValue([RAW]);
    expect(await listDelegatesOn(conn, "2026-10-26")).toHaveLength(1);
    expect(sql()).toContain("d.ArchivedAt IS NULL AND d.FromDate <= @Date AND d.ToDate >= @Date");
    expect(params().Date).toMatchObject({ type: TYPES.Date, value: new Date("2026-10-26T00:00:00Z") });
  });

  it("lists upcoming nominations for one person (as the person or the cover), or for everyone", async () => {
    db.executeQuery.mockResolvedValue([]);
    await listUpcomingDelegates(conn, "2026-10-26", 1);
    expect(sql()).toContain("d.ToDate >= @Today AND (@UserId IS NULL OR d.UserId = @UserId OR d.DelegateUserId = @UserId)");
    expect(params().UserId.value).toBe(1);
    db.executeQuery.mockClear();
    await listUpcomingDelegates(conn, "2026-10-26", null);
    expect(params().UserId.value).toBeNull();
  });

  it("reads one by id, locking it for update when asked, or null", async () => {
    db.executeQuery.mockResolvedValueOnce([RAW]).mockResolvedValueOnce([]);
    expect((await getDelegate(conn, 5, true))?.coverDelegateId).toBe(5);
    expect(sql()).toContain("WITH (UPDLOCK, ROWLOCK)");
    expect(await getDelegate(conn, 6)).toBeNull();
    expect(String(db.executeQuery.mock.calls[1][1])).not.toContain("UPDLOCK");
  });

  it("inserts a nomination and returns its id", async () => {
    db.executeQuery.mockResolvedValue([{ CoverDelegateId: 9 }]);
    expect(await insertDelegate(conn, { createdBy: "Fay", createdByUserId: 1, delegateUserId: 7, fromDate: "2026-10-26", leaveRequestId: 4, toDate: "2026-10-30", userId: 1 })).toBe(9);
    expect(sql()).toMatch(/^INSERT INTO dbo\.CoverDelegates/);
    expect(params()).toMatchObject({ DelegateUserId: { value: 7 }, FromDate: { value: new Date("2026-10-26T00:00:00Z") }, LeaveRequestId: { value: 4 }, ToDate: { value: new Date("2026-10-30T00:00:00Z") } });
  });

  it("ends a nomination by archiving it, only while live and still at the version read", async () => {
    db.executeQuery.mockResolvedValue([{ CoverDelegateId: 5 }]);
    expect(await archiveDelegateRow(conn, 5, VERSION.toString("base64"), { name: "Fay", userId: 1 }, "plans changed")).toBe(true);
    expect(sql()).toContain("SET ArchivedAt = SYSUTCDATETIME()");
    expect(sql()).toContain("WHERE CoverDelegateId = @Id AND ArchivedAt IS NULL AND RowVersion = @RowVersion");
    expect(sql()).not.toMatch(/DELETE/);
    expect(params().Reason.value).toBe("plans changed");
    db.executeQuery.mockResolvedValue([]);
    expect(await archiveDelegateRow(conn, 5, VERSION.toString("base64"), { name: "Fay", userId: 1 }, "x".repeat(300))).toBe(false);
    expect(String((db.executeQuery.mock.calls[1][2] as { name: string; value: unknown }[]).find((param) => param.name === "Reason")?.value)).toHaveLength(200);
  });
});
