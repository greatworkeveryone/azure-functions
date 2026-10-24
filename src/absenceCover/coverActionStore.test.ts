/// <reference types="jest" />
import { TYPES } from "tedious";
import { getCoverAction, insertCoverAction, itemKey, latestActionsByItem, listRecentActions, toCoverActionRow, type NewCoverAction } from "./coverActionStore";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));
const db = jest.requireMock("../db") as { executeQuery: jest.Mock };
const conn = {} as never;

const NEW: NewCoverAction = {
  absenceKind: "planned", absenceRef: "leave:11", action: "reassigned", actor: { kind: "system" }, actorName: "Floorplan (cover while away)", dueAt: new Date("2026-10-28T02:00:00Z"), fromUserId: 1,
  importance: "high", itemId: "12", itemLabel: "Job #12", itemType: "job", reasonCode: "due_before_return", reasonText: "It falls due.", returnDate: "2026-11-02", runId: "6f2c1e4e-1111-4222-8333-444455556666", toUserId: 2,
};
const RAW = {
  AbsenceKind: "planned", AbsenceRef: "leave:11", Action: "reassigned", ActorKind: "system", ActorName: "Floorplan", ActorUserId: null, CoverActionId: "7", CreatedAt: new Date("2026-10-26T03:00:00Z"), DryRun: false,
  DueAt: new Date("2026-10-28T02:00:00Z"), FromUserId: 1, Importance: "high", ItemId: "12", ItemLabel: "Job #12", ItemType: "job", ReasonCode: "due_before_return", ReasonText: "x", RelatedActionId: null,
  ReturnDate: "2026-11-02", RunId: "6F2C1E4E-1111-4222-8333-444455556666", ToUserId: 2,
};
const paramsOf = (): Record<string, { type: unknown; value: unknown }> => Object.fromEntries((db.executeQuery.mock.calls[0][2] as { name: string; type: unknown; value: unknown }[]).map((param) => [param.name, param]));

beforeEach(() => db.executeQuery.mockReset());

describe("insertCoverAction", () => {
  it("appends one row with every column bound as a parameter, and returns its id", async () => {
    db.executeQuery.mockResolvedValue([{ CoverActionId: "901" }]);
    expect(await insertCoverAction(conn, NEW)).toBe(901);
    const sql = String(db.executeQuery.mock.calls[0][1]);
    expect(sql).toMatch(/^INSERT INTO dbo\.CoverActions/);
    expect(sql).toContain("OUTPUT INSERTED.CoverActionId");
    expect(sql).not.toMatch(/UPDATE|DELETE/);
    const params = paramsOf();
    expect(params.ReturnDate).toMatchObject({ type: TYPES.Date, value: new Date("2026-11-02T00:00:00Z") });
    expect(params.RunId).toMatchObject({ type: TYPES.UniqueIdentifier, value: "6f2c1e4e-1111-4222-8333-444455556666" });
    expect(params).toMatchObject({ ActorKind: { value: "system" }, ActorUserId: { value: null }, DryRun: { value: 0 }, FromUserId: { value: 1 }, ItemId: { value: "12" }, RelatedActionId: { value: null }, ToUserId: { value: 2 } });
  });

  it("records a person as the actor, a dry run, the move being undone, and no cover", async () => {
    db.executeQuery.mockResolvedValue([{ CoverActionId: 1 }]);
    await insertCoverAction(conn, { ...NEW, action: "taken_back", actor: { kind: "user", userId: 4 }, actorName: "Dee", dryRun: true, relatedActionId: 100, returnDate: null, runId: null, toUserId: null });
    expect(paramsOf()).toMatchObject({ ActorKind: { value: "user" }, ActorUserId: { value: 4 }, DryRun: { value: 1 }, RelatedActionId: { value: 100 }, ReturnDate: { value: null }, RunId: { value: null }, ToUserId: { value: null } });
  });

  it("keeps a long label and reason inside their columns", async () => {
    db.executeQuery.mockResolvedValue([{ CoverActionId: 1 }]);
    await insertCoverAction(conn, { ...NEW, itemLabel: "x".repeat(400), reasonText: "y".repeat(700) });
    expect(String(paramsOf().ItemLabel.value)).toHaveLength(300);
    expect(String(paramsOf().ReasonText.value)).toHaveLength(500);
  });
});

describe("reading", () => {
  it("maps a row, keeping ids as numbers and the run id as text", () => {
    expect(toCoverActionRow(RAW)).toMatchObject({ coverActionId: 7, dryRun: false, dueAt: new Date("2026-10-28T02:00:00Z"), fromUserId: 1, relatedActionId: null, returnDate: "2026-11-02", runId: "6F2C1E4E-1111-4222-8333-444455556666", toUserId: 2 });
    expect(toCoverActionRow({ ...RAW, ActorKind: "user", DryRun: 1, DueAt: null, ReturnDate: null, RunId: null, ToUserId: null }))
      .toMatchObject({ actorKind: "user", dryRun: true, dueAt: null, returnDate: null, runId: null, toUserId: null });
  });

  it("reads one row by id, or null", async () => {
    db.executeQuery.mockResolvedValueOnce([RAW]).mockResolvedValueOnce([]);
    expect((await getCoverAction(conn, 7))?.coverActionId).toBe(7);
    expect(await getCoverAction(conn, 8)).toBeNull();
  });

  it("finds the latest row for each item touched in the window, by item key", async () => {
    db.executeQuery.mockResolvedValue([RAW, { ...RAW, CoverActionId: "8", ItemId: "13" }]);
    const latest = await latestActionsByItem(conn, 30);
    expect([...latest.keys()]).toEqual(["job:12", "job:13"]);
    expect(String(db.executeQuery.mock.calls[0][1])).toContain("SELECT MAX(CoverActionId) FROM dbo.CoverActions");
    expect(String(db.executeQuery.mock.calls[0][1])).toContain("GROUP BY ItemType, ItemId");
    expect(db.executeQuery.mock.calls[0][2]).toEqual([{ name: "Days", type: TYPES.Int, value: 30 }]);
    expect(itemKey("decision_request", "5")).toBe("decision_request:5");
  });

  it("lists recent rows newest first, capped", async () => {
    db.executeQuery.mockResolvedValue([RAW]);
    expect(await listRecentActions(conn, 14, 50)).toHaveLength(1);
    expect(String(db.executeQuery.mock.calls[0][1])).toContain("ORDER BY CoverActionId DESC");
    expect(db.executeQuery.mock.calls[0][2]).toEqual([{ name: "Days", type: TYPES.Int, value: 14 }, { name: "Limit", type: TYPES.Int, value: 50 }]);
  });
});
