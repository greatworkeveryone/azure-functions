/// <reference types="jest" />
import { absent, context, item } from "../__tests__/fixtures/absenceCover";
import type { CoverCaller } from "./access";
import { decideCoverItem, parseDecision } from "./decide";
import { planCover } from "./plan";
import type { CoverItem } from "./types";

jest.mock("./view", () => ({ loadLiveView: jest.fn() }));
jest.mock("./moves/apply", () => ({ applyCoverAction: jest.fn() }));

const view = jest.requireMock("./view") as { loadLiveView: jest.Mock };
const apply = jest.requireMock("./moves/apply") as { applyCoverAction: jest.Mock };
const conn = {} as never;

const manager: CoverCaller = { name: "Max Manager", roles: ["facilities_manager"], userId: 2 };
const due = (iso: string) => new Date(`${iso}T02:00:00Z`);

function world(items: CoverItem[], over = {}) {
  const ctx = context(over);
  view.loadLiveView.mockResolvedValue({ absent: [absent()], context: ctx, items, plan: planCover({ absent: [absent()], context: ctx, items, latest: new Map() }) });
}
const move = (over: Record<string, unknown> = {}) => ({ coverUserId: null, decision: "move" as const, itemId: "12", itemType: "job" as const, ...over });
const rejects = async (promise: Promise<unknown>, code: string, status: number) =>
  expect(promise).rejects.toMatchObject({ code, status });

beforeEach(() => {
  jest.resetAllMocks();
  apply.applyCoverAction.mockResolvedValue({ announce: jest.fn(async () => undefined), coverActionId: 8, status: "applied", toUserId: 8 });
  world([item({ dueAt: due("2026-11-20") })]);
});

describe("parseDecision", () => {
  it.each([
    ["no item type", { decision: "move", itemId: "1" }],
    ["an unknown item type", { decision: "move", itemId: "1", itemType: "invoice" }],
    ["an item id that is not digits", { decision: "move", itemId: "x", itemType: "job" }],
    ["a number for the id", { decision: "move", itemId: 1, itemType: "job" }],
    ["neither move nor keep", { decision: "approve", itemId: "1", itemType: "job" }],
    ["a cover that is not an id", { coverUserId: "2", decision: "move", itemId: "1", itemType: "job" }],
    ["a cover of zero", { coverUserId: 0, decision: "move", itemId: "1", itemType: "job" }],
  ])("refuses %s", (_label, body) => {
    expect(() => parseDecision(body as Record<string, unknown>)).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("accepts a move with or without a chosen cover, and a keep", () => {
    expect(parseDecision({ decision: "move", itemId: "1", itemType: "job" }).coverUserId).toBeNull();
    expect(parseDecision({ coverUserId: 7, decision: "move", itemId: "1", itemType: "decision_request" })).toMatchObject({ coverUserId: 7, itemType: "decision_request" });
    expect(parseDecision({ decision: "keep", itemId: "1", itemType: "email" }).decision).toBe("keep");
  });
});

describe("decideCoverItem: live only", () => {
  it.each(["off", "dry-run"] as const)("moves and keeps nothing while the engine is %s", async (mode) => {
    await rejects(decideCoverItem(conn, manager, move(), mode), "cover_switched_off", 409);
    await rejects(decideCoverItem(conn, manager, move({ decision: "keep" }), mode), "cover_switched_off", 409);
    expect(view.loadLiveView).not.toHaveBeenCalled();
    expect(apply.applyCoverAction).not.toHaveBeenCalled();
  });
});

describe("decideCoverItem: who may", () => {
  it("refuses admin, who arranges nobody's work", async () => {
    await rejects(decideCoverItem(conn, { name: "Ada Admin", roles: ["admin"], userId: 9 }, move(), "live"), "forbidden", 403);
    expect(apply.applyCoverAction).not.toHaveBeenCalled();
  });

  it("refuses a manager of another team", async () => {
    await rejects(decideCoverItem(conn, { name: "Ari", roles: ["accounts_manager"], userId: 6 }, move(), "live"), "forbidden", 403);
  });

  it.each([["facilities_manager", 2], ["cfo", 5], ["director", 4]])("lets a %s act for the facilities team", async (role, userId) => {
    const result = await decideCoverItem(conn, { name: "X", roles: [role], userId }, move(), "live");
    expect(result.decision).toBe("move");
  });
});

describe("decideCoverItem: move", () => {
  it("moves it to the proposed cover as the manager, and sends the notice after", async () => {
    const announce = jest.fn(async () => undefined);
    apply.applyCoverAction.mockResolvedValue({ announce, coverActionId: 8, status: "applied", toUserId: 2 });
    const result = await decideCoverItem(conn, manager, move(), "live");
    expect(result).toEqual({ coverActionId: 8, decision: "move", toUserId: 2 });
    expect(apply.applyCoverAction.mock.calls[0][1]).toMatchObject({
      action: "reassigned", actor: { kind: "user", name: "Max Manager", userId: 2 }, cover: { userId: 2 }, reasonCode: "moved_by_manager", runId: null,
    });
    expect(announce).toHaveBeenCalled();
  });

  it("pushes an escalation up its ladder when that is where the cover came from", async () => {
    world([item({ dueAt: due("2026-11-20") })], { absentIds: new Set([1, 2, 8]) });
    await decideCoverItem(conn, { name: "Dee", roles: ["director"], userId: 4 }, move(), "live");
    expect(apply.applyCoverAction.mock.calls[0][1]).toMatchObject({ action: "escalated", cover: { userId: 5 } });
  });

  it("moves it to a person the manager chooses, if that person may take it", async () => {
    await decideCoverItem(conn, manager, move({ coverUserId: 7 }), "live");
    expect(apply.applyCoverAction.mock.calls[0][1]).toMatchObject({ action: "reassigned", cover: { name: "Sam Facilities", userId: 7 } });
  });

  it.each([
    [9, "cover_not_eligible", "Ada Admin is admin, who approves nothing real, so they cannot take this."],
    [1, "cover_not_eligible", "Fay Facilities is the person who is away, so they cannot take this."],
    [99, "cover_not_active", "That person is not an active user."],
  ])("refuses a chosen cover %i who may not take it", async (coverUserId, code, message) => {
    await expect(decideCoverItem(conn, manager, move({ coverUserId }), "live")).rejects.toMatchObject({ code, message, status: 422 });
    expect(apply.applyCoverAction).not.toHaveBeenCalled();
  });

  it("asks the manager to choose when nobody who may take it is available", async () => {
    world([item({ dueAt: due("2026-11-20") })], { directory: [context().directory[0]] });
    await rejects(decideCoverItem(conn, manager, move(), "live"), "no_cover", 422);
  });

  it("refuses an item that cannot be moved from here", async () => {
    world([item({ capability: null, dueAt: due("2026-11-20"), id: "3", move: "none", type: "leave_approval" })]);
    await rejects(decideCoverItem(conn, manager, move({ itemId: "3", itemType: "leave_approval" }), "live"), "not_movable", 422);
  });

  it("is a conflict when the item is no longer at risk, or someone moved it first", async () => {
    await rejects(decideCoverItem(conn, manager, move({ itemId: "999" }), "live"), "changed", 409);
    apply.applyCoverAction.mockResolvedValue({ reason: "changed", status: "skipped" });
    await rejects(decideCoverItem(conn, manager, move(), "live"), "changed", 409);
  });
});

describe("decideCoverItem: keep", () => {
  it("records that the manager left it with the person, for this absence", async () => {
    const result = await decideCoverItem(conn, manager, move({ decision: "keep" }), "live");
    expect(result).toEqual({ coverActionId: 8, decision: "keep", toUserId: null });
    expect(apply.applyCoverAction.mock.calls[0][1]).toMatchObject({ action: "kept", cover: null, reasonCode: "kept_by_manager" });
    expect(apply.applyCoverAction.mock.calls[0][1].reasonText).toBe("Max Manager chose to leave this with Fay Facilities.");
  });

  it("is a conflict when the item has gone", async () => {
    await rejects(decideCoverItem(conn, manager, move({ decision: "keep", itemId: "999" }), "live"), "changed", 409);
  });
});
