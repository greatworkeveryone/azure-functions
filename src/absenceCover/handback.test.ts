/// <reference types="jest" />
import { DIRECTORY, absent } from "../__tests__/fixtures/absenceCover";
import type { CoverCaller } from "./access";
import type { CoverActionRow } from "./coverActionStore";
import { buildHandback, takeBackItem } from "./handback";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));
jest.mock("./coverActionStore", () => ({ getCoverAction: jest.fn(), insertCoverAction: jest.fn(), listRecentActions: jest.fn() }));
jest.mock("./view", () => ({ loadAbsences: jest.fn() }));
jest.mock("./inventory/emails", () => ({ probeEmailColumns: jest.fn() }));
jest.mock("../rentReview/store", () => ({ inTransaction: async (_c: unknown, work: () => Promise<unknown>) => work() }));
jest.mock("./moves/domain", () => {
  const actual = jest.requireActual("./moves/domain");
  return { ...actual, MOVERS: { ...actual.MOVERS, job_assignee: jest.fn(), decision_makers: jest.fn() } };
});

const db = jest.requireMock("../db") as { executeQuery: jest.Mock };
const store = jest.requireMock("./coverActionStore") as Record<"getCoverAction" | "insertCoverAction" | "listRecentActions", jest.Mock>;
const absences = jest.requireMock("./view") as { loadAbsences: jest.Mock };
const emails = jest.requireMock("./inventory/emails") as { probeEmailColumns: jest.Mock };
const domain = jest.requireMock("./moves/domain") as { MOVERS: Record<string, jest.Mock> };
const conn = {} as never;

const fay: CoverCaller = { name: "Fay Facilities", roles: ["facilities"], userId: 1 };
const when = new Date("2026-10-27T01:00:00Z");
const row = (over: Partial<CoverActionRow> = {}): CoverActionRow => ({
  absenceKind: "planned", absenceRef: "leave:11", action: "reassigned", actorKind: "system", actorName: "Floorplan (cover while away)", actorUserId: null, coverActionId: 100, createdAt: when,
  dryRun: false, dueAt: null, fromUserId: 1, importance: "medium", itemId: "12", itemLabel: "Job #12 · Leaking roof", itemType: "job", reasonCode: "due_before_return", reasonText: "It falls due.",
  relatedActionId: null, returnDate: "2026-11-02", runId: null, toUserId: 2, ...over,
});

beforeEach(() => {
  jest.resetAllMocks();
  absences.loadAbsences.mockResolvedValue({ absent: [], state: { directory: DIRECTORY } });
  store.listRecentActions.mockResolvedValue([]);
  emails.probeEmailColumns.mockResolvedValue({ assignedToUserId: true });
});

describe("buildHandback", () => {
  it("lists what moved from the person, and whether each is still with the cover", async () => {
    store.listRecentActions.mockResolvedValue([row(), row({ coverActionId: 101, itemId: "13" })]);
    db.executeQuery.mockResolvedValueOnce([{ Holder: 2, Id: 12 }]);
    const result = await buildHandback(conn, fay);
    expect(result.returned).toBe(true);
    expect(result.items.map((item) => [item.itemId, item.status, item.canTakeBack, item.coverName])).toEqual([
      ["12", "with_cover", true, "Max Manager"],
      ["13", "done", false, "Max Manager"],
    ]);
    expect(String(db.executeQuery.mock.calls[0][1])).toContain("Status <> N'Done' AND IsArchived = 0");
  });

  it("is not returned while they are still away", async () => {
    absences.loadAbsences.mockResolvedValue({ absent: [absent()], state: { directory: DIRECTORY } });
    expect((await buildHandback(conn, fay)).returned).toBe(false);
  });

  it("leaves out other people's moves, dry runs, suggestions and what was taken back", async () => {
    store.listRecentActions.mockResolvedValue([
      row({ coverActionId: 1, fromUserId: 3 }),
      row({ coverActionId: 2, dryRun: true }),
      row({ action: "suggested", coverActionId: 3 }),
      row({ coverActionId: 4 }),
      row({ action: "taken_back", coverActionId: 5, relatedActionId: 4 }),
    ]);
    expect((await buildHandback(conn, fay)).items).toEqual([]);
  });

  it("says an item pushed up the ladder or only told about cannot be taken back", async () => {
    store.listRecentActions.mockResolvedValue([
      row({ action: "escalated", coverActionId: 1, itemId: "40", itemType: "escalation", toUserId: null }),
      row({ coverActionId: 2, itemId: "9", itemType: "approval" }),
    ]);
    db.executeQuery.mockResolvedValueOnce([{ Holder: null, Id: 40 }]).mockResolvedValueOnce([{ Id: 9 }]);
    const items = (await buildHandback(conn, fay)).items;
    expect(items.map((item) => [item.itemType, item.canTakeBack])).toEqual([["escalation", false], ["approval", false]]);
    expect(items[0].coverName).toBe("the next person up");
  });

  it("checks decisions and emails where they are, and an email only where the column exists", async () => {
    store.listRecentActions.mockResolvedValue([row({ coverActionId: 1, itemId: "5", itemType: "decision_request" }), row({ coverActionId: 2, itemId: "77", itemType: "email" })]);
    db.executeQuery.mockResolvedValueOnce([{ Id: 5 }]).mockResolvedValueOnce([{ Holder: 2, Id: 77 }]);
    expect((await buildHandback(conn, fay)).items.map((item) => item.status)).toEqual(["with_cover", "with_cover"]);
    emails.probeEmailColumns.mockResolvedValue({ assignedToUserId: false });
    db.executeQuery.mockReset().mockResolvedValueOnce([{ Id: 5 }]);
    expect((await buildHandback(conn, fay)).items.map((item) => item.status)).toEqual(["with_cover", "done"]);
  });
});

describe("takeBackItem", () => {
  beforeEach(() => {
    store.getCoverAction.mockResolvedValue(row());
    store.insertCoverAction.mockResolvedValue(555);
    domain.MOVERS.job_assignee.mockResolvedValue(true);
    db.executeQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([{ DisplayName: "Max Manager" }]);
  });

  it("gives the item back through the same write that moved it, and logs the take-back against the move", async () => {
    expect(await takeBackItem(conn, fay, 100)).toEqual({ coverActionId: 555 });
    expect(domain.MOVERS.job_assignee).toHaveBeenCalledWith(conn, expect.objectContaining({
      actorName: "Fay Facilities", from: { name: "Max Manager", userId: 2 }, itemId: "12", takeBack: true, to: { name: "Fay Facilities", userId: 1 },
    }));
    expect(store.insertCoverAction.mock.calls[0][1]).toMatchObject({
      absenceRef: "leave:11", action: "taken_back", actor: { kind: "user", userId: 1 }, fromUserId: 2, reasonCode: "taken_back", relatedActionId: 100, toUserId: 1,
    });
  });

  it("refuses a move that is not theirs, and a dry run", async () => {
    await expect(takeBackItem(conn, { ...fay, userId: 3 }, 100)).rejects.toMatchObject({ status: 404 });
    store.getCoverAction.mockResolvedValue(row({ dryRun: true }));
    await expect(takeBackItem(conn, fay, 100)).rejects.toMatchObject({ status: 404 });
    store.getCoverAction.mockResolvedValue(null);
    await expect(takeBackItem(conn, fay, 100)).rejects.toMatchObject({ status: 404 });
    expect(domain.MOVERS.job_assignee).not.toHaveBeenCalled();
  });

  it("explains that something pushed up its ladder, or only told, cannot be taken back", async () => {
    store.getCoverAction.mockResolvedValue(row({ action: "escalated" }));
    await expect(takeBackItem(conn, fay, 100)).rejects.toMatchObject({ code: "cannot_take_back", status: 422 });
    store.getCoverAction.mockResolvedValue(row({ itemType: "approval" }));
    await expect(takeBackItem(conn, fay, 100)).rejects.toMatchObject({ code: "cannot_take_back", status: 422 });
    expect(store.insertCoverAction).not.toHaveBeenCalled();
  });

  it("is a conflict when it was already taken back", async () => {
    db.executeQuery.mockReset().mockResolvedValueOnce([{ Found: 1 }]);
    await expect(takeBackItem(conn, fay, 100)).rejects.toMatchObject({ code: "changed", message: "You have already taken this back.", status: 409 });
  });

  it("is a conflict, writing no row, when it is no longer with the cover", async () => {
    domain.MOVERS.job_assignee.mockResolvedValue(false);
    await expect(takeBackItem(conn, fay, 100)).rejects.toMatchObject({ status: 409 });
    expect(store.insertCoverAction).not.toHaveBeenCalled();
  });
});
