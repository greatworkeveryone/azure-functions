/// <reference types="jest" />
import { DIRECTORY, TODAY, absent, context, item } from "../__tests__/fixtures/absenceCover";
import type { CoverCaller } from "./access";
import type { CoverActionRow } from "./coverActionStore";
import { buildOverview } from "./overview";
import { planCover } from "./plan";
import type { CoverItem } from "./types";
import type { LiveView } from "./view";

jest.mock("./coverActionStore", () => ({ ...jest.requireActual("./coverActionStore"), listRecentActions: jest.fn() }));
const store = jest.requireMock("./coverActionStore") as { listRecentActions: jest.Mock };
const conn = {} as never;

const manager: CoverCaller = { name: "Max Manager", roles: ["facilities_manager"], userId: 2 };
const accountsManager: CoverCaller = { name: "Ari", roles: ["accounts_manager"], userId: 6 };
const director: CoverCaller = { name: "Dee", roles: ["director"], userId: 4 };
const due = (iso: string) => new Date(`${iso}T02:00:00Z`);

const row = (over: Partial<CoverActionRow> = {}): CoverActionRow => ({
  absenceKind: "planned", absenceRef: "leave:11", action: "reassigned", actorKind: "system", actorName: "Floorplan (cover while away)", actorUserId: null, coverActionId: 100, createdAt: new Date("2026-10-26T03:00:00Z"),
  dryRun: false, dueAt: null, fromUserId: 1, importance: "medium", itemId: "13", itemLabel: "Job #13", itemType: "job", reasonCode: "due_before_return", reasonText: "It falls due.", relatedActionId: null,
  returnDate: "2026-11-02", runId: null, toUserId: 7, ...over,
});

function view(items: CoverItem[], over: { absent?: ReturnType<typeof absent>[]; delegates?: LiveView["context"]["delegates"] } = {}): LiveView {
  const away = over.absent ?? [absent()];
  const ctx = context({ absentIds: new Set(away.map((person) => person.userId)), delegates: over.delegates ?? [] });
  return {
    absent: away,
    context: ctx,
    holidays: new Set(),
    inactivityAvailable: true,
    inactivityReason: null,
    items,
    plan: planCover({ absent: away, context: ctx, items, latest: new Map() }),
    state: { directory: DIRECTORY } as LiveView["state"],
    today: TODAY,
  };
}

beforeEach(() => {
  store.listRecentActions.mockReset().mockResolvedValue([]);
  delete process.env.ESCALATION_HOLIDAYS;
});

describe("buildOverview: who is away", () => {
  it("lists them with why, until when, how much waits and who covers", async () => {
    const delegates = [{ coverDelegateId: 4, delegateUserId: 7, fromDate: "2026-10-26", leaveRequestId: 11, toDate: "2026-10-30", userId: 1 }];
    store.listRecentActions.mockResolvedValue([row()]);
    const result = await buildOverview(conn, manager, view([item({ dueAt: due("2026-11-10"), id: "12" }), item({ dueAt: due("2026-10-28"), id: "13" })], { delegates }), "live");
    expect(result.away).toEqual([
      {
        cover: { name: "Sam Facilities", source: "delegate", userId: 7 }, endDate: "2026-10-30", itemCount: 2, kind: "planned", lastSeenOn: null, movedCount: 1, name: "Fay Facilities",
        reason: "On leave until 30/10/2026", returnDate: "2026-11-02", role: "facilities", startDate: "2026-10-26", suggestedCount: 2, userId: 1,
      },
    ]);
    expect(result.today).toBe(TODAY);
  });

  it("shows only the manager's own team, and everyone to a director", async () => {
    const accountsPerson = absent({ name: "Ann Accounts", role: "accounts", userId: 3 });
    const both = view([item({ dueAt: due("2026-10-28"), id: "1" }), item({ dueAt: due("2026-10-28"), id: "2", ownerUserId: 3 })], { absent: [absent(), accountsPerson] });
    expect((await buildOverview(conn, manager, both, "live")).away.map((person) => person.name)).toEqual(["Fay Facilities"]);
    expect((await buildOverview(conn, accountsManager, both, "live")).away.map((person) => person.name)).toEqual(["Ann Accounts"]);
    expect((await buildOverview(conn, director, both, "live")).away.map((person) => person.name)).toEqual(["Fay Facilities", "Ann Accounts"]);
    expect((await buildOverview(conn, manager, both, "live")).suggested.map((entry) => entry.itemId)).toEqual(["1"]);
  });

  it("shows admin nothing: admin arranges nobody's work", async () => {
    const result = await buildOverview(conn, { name: "Ada", roles: ["admin"], userId: 9 }, view([item({ dueAt: due("2026-10-28") })]), "live");
    expect(result.away).toEqual([]);
    expect(result.suggested).toEqual([]);
  });

  it("says which calendar return dates use and whether sign-in tracking is on", async () => {
    expect((await buildOverview(conn, director, view([]), "live")).calendar).toBe("weekends_only");
    process.env.ESCALATION_HOLIDAYS = "2026-12-25";
    const result = await buildOverview(conn, director, { ...view([]), inactivityAvailable: false, inactivityReason: "stale" }, "live");
    expect(result.calendar).toBe("holidays");
    expect(result.inactivity).toEqual({ available: false, days: 3, reason: "stale" });
  });
});

describe("buildOverview: what is waiting", () => {
  it("describes an item with its proposed cover, the reason, and whether a live run would move it", async () => {
    const result = await buildOverview(conn, manager, view([item({ dueAt: due("2026-10-28"), id: "1", importance: "high" }), item({ dueAt: due("2026-11-10"), id: "2" })]), "live");
    expect(result.suggested).toHaveLength(2);
    expect(result.suggested[0]).toMatchObject({
      absence: { kind: "planned", returnDate: "2026-11-02" }, autoMove: true, canMove: true, cover: { name: "Max Manager", role: "facilities_manager", source: "team_manager", userId: 2 },
      deepLink: "/jobs?jobId=12", importance: "high", itemId: "1", itemType: "job", movable: true, owner: { name: "Fay Facilities", userId: 1 }, whyNot: null,
    });
    expect(result.suggested[0].dueAt).toBe("2026-10-28T02:00:00.000Z");
    expect(result.suggested[1]).toMatchObject({ autoMove: false, canMove: true });
  });

  it.each(["off", "dry-run"] as const)("lets a manager move nothing while the engine is %s", async (mode) => {
    const result = await buildOverview(conn, manager, view([item({ dueAt: due("2026-10-28") })]), mode);
    expect(result.mode).toBe(mode);
    expect(result.suggested[0]).toMatchObject({ autoMove: true, canMove: false, movable: true, whyNot: null });
  });

  it("says why an item that cannot be moved from here cannot", async () => {
    const leave = item({ capability: null, dueAt: due("2026-10-28"), move: "none", type: "leave_approval" });
    const result = await buildOverview(conn, manager, view([leave]), "live");
    expect(result.suggested[0]).toMatchObject({ canMove: false, movable: false, whyNot: "Leave approvals follow the reporting line, which the CFO or a director changes." });
  });

  it("asks a manager to choose when nobody who may take it is available", async () => {
    const lonely = view([item({ dueAt: due("2026-10-28") })]);
    lonely.plan = planCover({ absent: lonely.absent, context: context({ directory: [DIRECTORY[0]] }), items: lonely.items, latest: new Map() });
    const result = await buildOverview(conn, manager, lonely, "live");
    expect(result.suggested[0]).toMatchObject({ canMove: false, cover: null, movable: true, whyNot: "Nobody who may take it is available. Choose someone." });
  });
});

describe("buildOverview: what moved", () => {
  it("lists moves and escalations of the last 14 days with names, and marks what was taken back", async () => {
    store.listRecentActions.mockResolvedValue([
      row({ coverActionId: 3, itemId: "14", takenBack: undefined } as Partial<CoverActionRow>),
      row({ action: "taken_back", coverActionId: 4, fromUserId: 7, relatedActionId: 2, toUserId: 1 }),
      row({ coverActionId: 2 }),
      row({ action: "escalated", coverActionId: 5, itemId: "40", itemType: "escalation", toUserId: null }),
    ]);
    const result = await buildOverview(conn, manager, view([]), "live");
    expect(store.listRecentActions).toHaveBeenCalledWith(conn, 14);
    expect(result.moved.map((moved) => [moved.coverActionId, moved.takenBack, moved.canTakeBack, moved.to?.name ?? null])).toEqual([
      [3, false, true, "Sam Facilities"],
      [2, true, true, "Sam Facilities"],
      [5, false, false, null],
    ]);
    expect(result.moved[0]).toMatchObject({ absenceKind: "planned", at: "2026-10-26T03:00:00.000Z", from: { name: "Fay Facilities", userId: 1 }, label: "Job #13", returnDate: "2026-11-02" });
  });

  it("leaves out a dry run's rows, suggestions and keeps", async () => {
    store.listRecentActions.mockResolvedValue([row({ dryRun: true }), row({ action: "suggested", coverActionId: 6 }), row({ action: "kept", coverActionId: 7 })]);
    expect((await buildOverview(conn, manager, view([]), "live")).moved).toEqual([]);
  });

  it("can not take back an approval notice, and names a person who has since left", async () => {
    store.listRecentActions.mockResolvedValue([row({ itemId: "9", itemType: "approval", toUserId: 99 })]);
    const [moved] = (await buildOverview(conn, manager, view([]), "live")).moved;
    expect(moved.canTakeBack).toBe(false);
    expect(moved.to?.name).toBe("Former staff member");
  });
});
