/// <reference types="jest" />
import { absent, context, item } from "../__tests__/fixtures/absenceCover";
import type { CoverActionRow } from "./coverActionStore";
import { runAbsenceCover } from "./engine";
import { planCover } from "./plan";
import type { CoverItem } from "./types";

jest.mock("./view", () => ({ loadLiveView: jest.fn() }));
jest.mock("./moves/apply", () => ({ applyCoverAction: jest.fn() }));

const view = jest.requireMock("./view") as { loadLiveView: jest.Mock };
const apply = jest.requireMock("./moves/apply") as { applyCoverAction: jest.Mock };
const conn = {} as never;

const MONDAY = new Date("2026-10-26T03:00:00Z");
const SATURDAY = new Date("2026-10-24T03:00:00Z");
const soon = (iso: string) => new Date(`${iso}T02:00:00Z`);

function lastRow(over: Partial<CoverActionRow>): CoverActionRow {
  return {
    absenceKind: "planned", absenceRef: "leave:11", action: "suggested", actorKind: "system", actorName: "x", actorUserId: null, coverActionId: 1, createdAt: MONDAY, dryRun: false,
    dueAt: null, fromUserId: 1, importance: "medium", itemId: "1", itemLabel: "x", itemType: "job", reasonCode: "x", reasonText: "x", relatedActionId: null, returnDate: null, runId: null, toUserId: null, ...over,
  };
}

function world(items: CoverItem[], latest: CoverActionRow[] = [], over = {}) {
  const ctx = context(over);
  const plan = planCover({ absent: [absent()], context: ctx, items, latest: new Map(latest.map((row) => [`${row.itemType}:${row.itemId}`, row])) });
  view.loadLiveView.mockResolvedValue({ absent: [absent()], context: ctx, inactivityAvailable: true, items, plan });
}

const run = (over: Record<string, unknown> = {}) =>
  runAbsenceCover({ accessLoggingOn: true, connection: conn, inactivityDays: 3, maxActions: 50, mode: "live", now: MONDAY, ...over } as never);

const written = () => apply.applyCoverAction.mock.calls.map((call) => call[1]);

beforeEach(() => {
  jest.resetAllMocks();
  apply.applyCoverAction.mockImplementation(async () => ({ announce: jest.fn(async () => undefined), coverActionId: 5, status: "applied", toUserId: 2 }));
});

describe("runAbsenceCover: unexpected volume of inactivity", () => {
  const inactive = (userId: number) => absent({ endDate: null, kind: "inactive", name: `Person ${userId}`, ref: `inactive:2026-10-20`, returnDate: null, userId });

  function crowd(people: ReturnType<typeof inactive>[]) {
    const ctx = context();
    const items = [item({ dueAt: soon("2026-10-28"), id: "1" })];
    const plan = planCover({ absent: people, context: ctx, items, latest: new Map() });
    view.loadLiveView.mockResolvedValue({ absent: people, context: ctx, inactivityAvailable: true, items, plan });
  }

  it("aborts, writes nothing and says why when more than 20% of active staff look absent from their sign-ins", async () => {
    crowd([inactive(1), inactive(3)]); // 2 of 9 active staff
    const log = jest.fn();
    const report = await run({ log });
    expect(report.aborted).toMatch(/2 of 9 active staff look absent from their sign-ins/);
    expect(apply.applyCoverAction).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("aborted"));
    expect(report).toMatchObject({ moved: 0, suggested: 0 });
  });

  it("carries on at exactly 20% or below", async () => {
    crowd([inactive(1)]);
    expect((await run({})).aborted).toBeNull();
  });

  it("does not count people on leave towards the limit: booked leave is not unexpected", async () => {
    const ctx = context();
    const people = [absent(), absent({ name: "B", ref: "leave:2", userId: 3 }), absent({ name: "C", ref: "leave:3", userId: 4 })];
    view.loadLiveView.mockResolvedValue({ absent: people, context: ctx, inactivityAvailable: true, items: [], plan: { alreadyHandled: 0, entries: [], notStranded: 0, stayed: 0 } });
    expect((await run({})).aborted).toBeNull();
  });

  it("aborts a dry run too, so the dry run shows the same thing the live run would do", async () => {
    crowd([inactive(1), inactive(3)]);
    expect((await run({ mode: "dry-run" })).aborted).not.toBeNull();
  });
});

describe("runAbsenceCover: a business day only", () => {
  it("does nothing on a weekend and reads nothing", async () => {
    const report = await run({ now: SATURDAY });
    expect(report).toMatchObject({ businessDay: false, moved: 0 });
    expect(view.loadLiveView).not.toHaveBeenCalled();
  });

  it("does nothing on a configured public holiday", async () => {
    process.env.ESCALATION_HOLIDAYS = "2026-10-26";
    try {
      expect((await run()).businessDay).toBe(false);
    } finally {
      delete process.env.ESCALATION_HOLIDAYS;
    }
  });

  it("reports an empty day when nobody is away", async () => {
    view.loadLiveView.mockResolvedValue({ absent: [], context: context(), inactivityAvailable: false, items: [], plan: { alreadyHandled: 0, entries: [], notStranded: 0, stayed: 0 } });
    expect(await run()).toMatchObject({ absent: 0, items: 0, moved: 0, suggested: 0 });
    expect(apply.applyCoverAction).not.toHaveBeenCalled();
  });
});

describe("runAbsenceCover: live", () => {
  it("moves what falls due before they are back, escalates from the ladder, and suggests the rest", async () => {
    world([item({ dueAt: soon("2026-10-28"), id: "1" }), item({ dueAt: soon("2026-11-20"), id: "2" })]);
    const report = await run();
    expect(report).toMatchObject({ absent: 1, escalated: 0, items: 2, moved: 1, suggested: 1, wouldMove: 0 });
    expect(written().map((row) => [row.item.id, row.action, row.cover?.userId ?? null, row.dryRun])).toEqual([
      ["1", "reassigned", 2, false],
      ["2", "suggested", 2, false],
    ]);
    expect(written()[0]).toMatchObject({ actor: { kind: "system" }, reasonCode: "due_before_return", runId: expect.any(String) });
  });

  it("counts a move up the ladder as escalated", async () => {
    world([item({ dueAt: soon("2026-10-28") })], [], { absentIds: new Set([1, 2, 8]) });
    expect(await run()).toMatchObject({ escalated: 1, moved: 0 });
  });

  it("sends the cover's notice email after each move, and a failed send does not fail the run", async () => {
    const announce = jest.fn().mockRejectedValue(new Error("mail down"));
    apply.applyCoverAction.mockResolvedValue({ announce, coverActionId: 5, status: "applied", toUserId: 2 });
    world([item({ dueAt: soon("2026-10-28") })]);
    expect(await run()).toMatchObject({ errors: [], moved: 1 });
    expect(announce).toHaveBeenCalled();
  });

  it("carries on after one item fails, and reports it", async () => {
    apply.applyCoverAction.mockRejectedValueOnce(new Error("deadlock")).mockResolvedValue({ announce: jest.fn(async () => undefined), coverActionId: 5, status: "applied", toUserId: 2 });
    world([item({ dueAt: soon("2026-10-28"), id: "1" }), item({ dueAt: soon("2026-10-29"), id: "2" })]);
    const onError = jest.fn();
    const report = await run({ onError });
    expect(report.errors).toEqual([{ item: "job:1", message: "deadlock" }]);
    expect(report.moved).toBe(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ item: expect.objectContaining({ id: "1" }) }));
  });

  it("counts an item someone else moved first as raced, not as a move", async () => {
    apply.applyCoverAction.mockResolvedValue({ reason: "changed", status: "skipped" });
    world([item({ dueAt: soon("2026-10-28") })]);
    expect(await run()).toMatchObject({ moved: 0, raced: 1 });
  });
});

describe("runAbsenceCover: at most MAX_ACTIONS a run, most urgent first", () => {
  const items = [
    item({ dueAt: soon("2026-10-30"), id: "1", importance: "low" }),
    item({ dueAt: soon("2026-10-30"), id: "2", importance: "high" }),
    item({ dueAt: soon("2026-10-28"), id: "3", importance: "medium" }),
  ];

  it("writes the most urgent and defers the rest, counting them", async () => {
    world(items);
    const report = await run({ maxActions: 2 });
    expect(written().map((row) => row.item.id)).toEqual(["2", "3"]);
    expect(report).toMatchObject({ deferred: 1, moved: 2 });
  });

  it("counts suggestions against the same cap", async () => {
    world([...items, item({ dueAt: soon("2026-12-01"), id: "4" })]);
    expect((await run({ maxActions: 3 })).deferred).toBe(1);
  });
});

describe("runAbsenceCover: dry run writes suggested rows only and moves nothing", () => {
  it("records what would move as a suggestion that says so", async () => {
    world([item({ dueAt: soon("2026-10-28"), id: "1" }), item({ dueAt: soon("2026-11-20"), id: "2" })]);
    const report = await run({ mode: "dry-run" });
    expect(written().every((row) => row.action === "suggested" && row.dryRun === true)).toBe(true);
    expect(written()[0]).toMatchObject({ reasonCode: "dry_run_would_move", cover: { userId: 2 } });
    expect(written()[0].reasonText).toMatch(/^Dry run: would have moved this\./);
    expect(written()[1].reasonCode).toBe("due_after_return");
    expect(report).toMatchObject({ dryRun: true, moved: 0, suggested: 1, wouldMove: 1 });
  });

  it("does not write the same suggestion twice for one absence", async () => {
    world([item({ dueAt: soon("2026-11-20"), id: "1" })], [lastRow({ itemId: "1" })]);
    expect(await run({ mode: "dry-run" })).toMatchObject({ suggested: 0 });
    expect(apply.applyCoverAction).not.toHaveBeenCalled();
  });

  it("writes again for a new absence", async () => {
    world([item({ dueAt: soon("2026-11-20"), id: "1" })], [lastRow({ absenceRef: "leave:9", itemId: "1" })]);
    expect(await run({ mode: "dry-run" })).toMatchObject({ suggested: 1 });
  });
});

describe("runAbsenceCover: idempotent", () => {
  it("does not suggest again in a live run", async () => {
    world([item({ dueAt: soon("2026-11-20"), id: "1" })], [lastRow({ itemId: "1" })]);
    expect(await run()).toMatchObject({ suggested: 0 });
  });

  it("moves an item that was suggested once it falls due before they are back", async () => {
    world([item({ dueAt: soon("2026-10-28"), id: "1" })], [lastRow({ itemId: "1" })]);
    expect(await run()).toMatchObject({ moved: 1 });
  });

  it("leaves alone what a manager kept or the person took back", async () => {
    world([item({ dueAt: soon("2026-10-28"), id: "1" }), item({ dueAt: soon("2026-10-28"), id: "2" })], [lastRow({ action: "kept", itemId: "1" }), lastRow({ action: "taken_back", fromUserId: 2, itemId: "2", toUserId: 1 })]);
    const report = await run();
    expect(report).toMatchObject({ alreadyHandled: 2, moved: 0 });
    expect(apply.applyCoverAction).not.toHaveBeenCalled();
  });
});
