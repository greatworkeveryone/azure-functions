/// <reference types="jest" />
import { DIRECTORY, TODAY, user } from "../__tests__/fixtures/absenceCover";
import type { CoverCaller } from "./access";
import type { DelegateRow } from "./delegateStore";
import { archiveNomination, listNominations, parseNomination, saveNomination } from "./nominate";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));
jest.mock("../escalation/store", () => ({ listActiveUsers: jest.fn() }));
jest.mock("../peopleWorkflow", () => ({ loadPeople: jest.fn() }));
jest.mock("./delegateStore", () => ({ archiveDelegateRow: jest.fn(), getDelegate: jest.fn(), insertDelegate: jest.fn(), listUpcomingDelegates: jest.fn() }));

const db = jest.requireMock("../db") as { executeQuery: jest.Mock };
const escalation = jest.requireMock("../escalation/store") as { listActiveUsers: jest.Mock };
const people = jest.requireMock("../peopleWorkflow") as { loadPeople: jest.Mock };
const store = jest.requireMock("./delegateStore") as Record<"archiveDelegateRow" | "getDelegate" | "insertDelegate" | "listUpcomingDelegates", jest.Mock>;
const conn = {} as never;

const fay: CoverCaller = { name: "Fay Facilities", roles: ["facilities"], userId: 1 };
const manager: CoverCaller = { name: "Max Manager", roles: ["facilities_manager"], userId: 2 };
const row = (over: Partial<DelegateRow> = {}): DelegateRow => ({
  archivedAt: null, coverDelegateId: 5, createdAt: new Date(), createdBy: "Fay Facilities", delegateName: "Sam Facilities", delegateUserId: 7, fromDate: "2026-10-26", leaveRequestId: null,
  rowVersion: "rv", toDate: "2026-10-30", userId: 1, userName: "Fay Facilities", ...over,
});
const input = (over = {}) => ({ delegateUserId: 7, fromDate: "2026-10-26", leaveRequestId: null, toDate: "2026-10-30", userId: null as number | null, ...over });

beforeEach(() => {
  jest.resetAllMocks();
  escalation.listActiveUsers.mockResolvedValue([...DIRECTORY, user(10, "user", "Una User")]);
  people.loadPeople.mockResolvedValue({ links: [], revision: 1, staff: [], updatedAt: new Date(), updatedBy: "x" });
  store.listUpcomingDelegates.mockResolvedValue([]);
  store.insertDelegate.mockResolvedValue(5);
  store.getDelegate.mockResolvedValue(row());
});

describe("parseNomination", () => {
  it.each([
    ["no cover", { fromDate: "2026-10-26", toDate: "2026-10-30" }],
    ["a cover that is not an id", { delegateUserId: "7", fromDate: "2026-10-26", toDate: "2026-10-30" }],
    ["a start that is not a date", { delegateUserId: 7, fromDate: "26/10/2026", toDate: "2026-10-30" }],
    ["an impossible date", { delegateUserId: 7, fromDate: "2026-02-30", toDate: "2026-03-02" }],
    ["an end before the start", { delegateUserId: 7, fromDate: "2026-10-30", toDate: "2026-10-26" }],
    ["more than a year", { delegateUserId: 7, fromDate: "2026-01-01", toDate: "2027-01-02" }],
    ["a leave request that is not an id", { delegateUserId: 7, fromDate: "2026-10-26", leaveRequestId: "x", toDate: "2026-10-30" }],
  ])("refuses %s", (_label, body) => {
    expect(() => parseNomination(body as Record<string, unknown>)).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("accepts a year exactly and a leave request", () => {
    expect(parseNomination({ delegateUserId: 7, fromDate: "2026-01-01", toDate: "2026-12-31" }).userId).toBeNull();
    expect(parseNomination({ delegateUserId: 7, fromDate: "2026-10-26", leaveRequestId: 4, toDate: "2026-10-30", userId: 3 })).toMatchObject({ leaveRequestId: 4, userId: 3 });
  });
});

describe("saveNomination", () => {
  it("saves the person's own nomination and returns it", async () => {
    const result = await saveNomination(conn, fay, input(), TODAY);
    expect(result).toMatchObject({ created: true, nomination: { coverDelegateId: 5, delegateName: "Sam Facilities", userId: 1 } });
    expect(store.insertDelegate).toHaveBeenCalledWith(conn, { createdBy: "Fay Facilities", createdByUserId: 1, delegateUserId: 7, fromDate: "2026-10-26", leaveRequestId: null, toDate: "2026-10-30", userId: 1 });
  });

  it("saves the same nomination twice as one", async () => {
    store.listUpcomingDelegates.mockResolvedValue([row()]);
    expect(await saveNomination(conn, fay, input(), TODAY)).toMatchObject({ created: false });
    expect(store.insertDelegate).not.toHaveBeenCalled();
  });

  describe("who may nominate for someone", () => {
    it("lets their reporting-line manager", async () => {
      people.loadPeople.mockResolvedValue({ links: [{ managerId: 4, userId: 1 }], revision: 1, staff: [] });
      expect((await saveNomination(conn, { name: "Dee", roles: ["director"], userId: 4 }, input({ userId: 1 }), TODAY)).created).toBe(true);
      expect(store.insertDelegate.mock.calls[0][1]).toMatchObject({ createdBy: "Dee", userId: 1 });
    });

    it("lets a manager of their team, the CFO and a director", async () => {
      for (const caller of [manager, { name: "Cam", roles: ["cfo"], userId: 5 }, { name: "Dee", roles: ["director"], userId: 4 }]) {
        expect((await saveNomination(conn, caller, input({ userId: 1 }), TODAY)).created).toBe(true);
      }
    });

    it("refuses a colleague, another team's manager and admin", async () => {
      for (const caller of [{ name: "Sam", roles: ["facilities"], userId: 7 }, { name: "Ari", roles: ["accounts_manager"], userId: 6 }, { name: "Ada", roles: ["admin"], userId: 9 }]) {
        await expect(saveNomination(conn, caller, input({ userId: 1 }), TODAY)).rejects.toMatchObject({ status: 403 });
      }
      expect(store.insertDelegate).not.toHaveBeenCalled();
    });
  });

  describe("who may be the cover", () => {
    it.each([
      ["themselves", 1, "delegate_is_self"],
      ["admin", 9, "delegate_cannot_cover"],
      ["someone who cannot work in the inbox", 10, "delegate_cannot_cover"],
      ["someone who is not an active user", 99, "delegate_not_active"],
    ])("refuses %s", async (_label, delegateUserId, code) => {
      await expect(saveNomination(conn, fay, input({ delegateUserId }), TODAY)).rejects.toMatchObject({ code, status: 422 });
      expect(store.insertDelegate).not.toHaveBeenCalled();
    });
  });

  it("refuses dates that have passed, but not yesterday's end", async () => {
    await expect(saveNomination(conn, fay, input({ fromDate: "2026-10-01", toDate: "2026-10-20" }), TODAY)).rejects.toMatchObject({ code: "dates_past" });
    expect((await saveNomination(conn, fay, input({ fromDate: "2026-10-20", toDate: "2026-10-25" }), TODAY)).created).toBe(true);
  });

  describe("tied to a leave request", () => {
    it("accepts their own pending or approved request", async () => {
      db.executeQuery.mockResolvedValue([{ Status: "approved", UserId: 1 }]);
      expect((await saveNomination(conn, fay, input({ leaveRequestId: 4 }), TODAY)).created).toBe(true);
      expect(store.insertDelegate.mock.calls[0][1].leaveRequestId).toBe(4);
    });

    it.each([
      ["someone else's request", [{ Status: "approved", UserId: 3 }], 404],
      ["a request that does not exist", [], 404],
      ["a declined request", [{ Status: "declined", UserId: 1 }], 422],
    ])("refuses %s", async (_label, rows, status) => {
      db.executeQuery.mockResolvedValue(rows);
      await expect(saveNomination(conn, fay, input({ leaveRequestId: 4 }), TODAY)).rejects.toMatchObject({ status });
    });
  });
});

describe("archiveNomination", () => {
  beforeEach(() => store.getDelegate.mockResolvedValue(row()));

  it("ends their own nomination with a reason", async () => {
    store.archiveDelegateRow.mockResolvedValue(true);
    await archiveNomination(conn, fay, 5, "rv", " plans changed ");
    expect(store.archiveDelegateRow).toHaveBeenCalledWith(conn, 5, "rv", { name: "Fay Facilities", userId: 1 }, "plans changed");
  });

  it("gives a reason when none is given", async () => {
    store.archiveDelegateRow.mockResolvedValue(true);
    await archiveNomination(conn, fay, 5, "rv", null);
    expect(store.archiveDelegateRow.mock.calls[0][4]).toBe("Ended by hand");
  });

  it("lets a manager of their team end it, and refuses a colleague", async () => {
    store.archiveDelegateRow.mockResolvedValue(true);
    await archiveNomination(conn, manager, 5, "rv", null);
    await expect(archiveNomination(conn, { name: "Sam", roles: ["facilities"], userId: 7 }, 5, "rv", null)).rejects.toMatchObject({ status: 403 });
  });

  it("is a 404 for one that has ended or never was, and a 409 for a stale version", async () => {
    store.getDelegate.mockResolvedValue(row({ archivedAt: new Date() }));
    await expect(archiveNomination(conn, fay, 5, "rv", null)).rejects.toMatchObject({ status: 404 });
    store.getDelegate.mockResolvedValue(null);
    await expect(archiveNomination(conn, fay, 5, "rv", null)).rejects.toMatchObject({ status: 404 });
    store.getDelegate.mockResolvedValue(row());
    await expect(archiveNomination(conn, fay, 5, "old", null)).rejects.toMatchObject({ code: "changed", status: 409 });
    store.archiveDelegateRow.mockResolvedValue(false);
    await expect(archiveNomination(conn, fay, 5, "rv", null)).rejects.toMatchObject({ status: 409 });
  });
});

describe("listNominations", () => {
  it("lists the caller's own by default", async () => {
    store.listUpcomingDelegates.mockResolvedValue([row()]);
    const list = await listNominations(conn, fay, TODAY, null);
    expect(list).toHaveLength(1);
    expect(store.listUpcomingDelegates).toHaveBeenCalledWith(conn, TODAY, 1);
  });

  it("lets a manager see their team member's, and refuses a colleague", async () => {
    await listNominations(conn, manager, TODAY, 1);
    await expect(listNominations(conn, { name: "Sam", roles: ["facilities"], userId: 7 }, TODAY, 1)).rejects.toMatchObject({ status: 403 });
  });
});
