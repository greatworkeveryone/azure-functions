/// <reference types="jest" />
import { DIRECTORY, FACTS, item } from "../__tests__/fixtures/absenceCover";
import { loadAbsences, loadLiveView } from "./view";

jest.mock("./load", () => ({ loadCoverState: jest.fn() }));
jest.mock("./inventory", () => ({ loadInventory: jest.fn() }));
jest.mock("./coverActionStore", () => ({ ...jest.requireActual("./coverActionStore"), latestActionsByItem: jest.fn() }));

const load = jest.requireMock("./load") as { loadCoverState: jest.Mock };
const inventory = jest.requireMock("./inventory") as { loadInventory: jest.Mock };
const store = jest.requireMock("./coverActionStore") as { latestActionsByItem: jest.Mock };
const conn = {} as never;

const NOW = new Date("2026-10-26T03:00:00Z"); // Monday 12:30 in Darwin
const state = (over: Record<string, unknown> = {}) => ({
  accessLogNewestOn: "2026-10-26", delegates: [], directory: DIRECTORY, emailColumns: { assignedToUserId: false }, facts: FACTS, lastSeenOn: new Map(),
  leaves: [{ approvedOn: "2026-10-01", endDate: "2026-10-30", kind: "annual_leave", requestId: 11, startDate: "2026-10-26", userId: 1 }],
  links: [], staff: [], ...over,
});

beforeEach(() => {
  jest.resetAllMocks();
  load.loadCoverState.mockResolvedValue(state());
  inventory.loadInventory.mockResolvedValue([item({ dueAt: new Date("2026-10-28T02:00:00Z") })]);
  store.latestActionsByItem.mockResolvedValue(new Map());
});

describe("loadAbsences", () => {
  it("says who is away today, from the leave and the sign-in log, and who therefore cannot be a cover", async () => {
    const result = await loadAbsences(conn, { accessLoggingOn: true, inactivityDays: 3, now: NOW });
    expect(result.today).toBe("2026-10-26");
    expect(result.absent.map((person) => [person.userId, person.kind])).toEqual([[1, "planned"]]);
    expect(result.context.absentIds).toEqual(new Set([1]));
    expect(result.inactivityAvailable).toBe(true);
    expect(load.loadCoverState).toHaveBeenCalledWith(conn, "2026-10-26", true);
  });

  it("calls someone inactive only with sign-in tracking on, and says when it is off", async () => {
    load.loadCoverState.mockResolvedValue(state({ leaves: [], lastSeenOn: new Map([[7, "2026-10-20"]]) }));
    expect((await loadAbsences(conn, { accessLoggingOn: true, inactivityDays: 3, now: NOW })).absent.map((person) => person.userId)).toEqual([7]);
    const off = await loadAbsences(conn, { accessLoggingOn: false, inactivityDays: 3, now: NOW });
    expect(off.absent).toEqual([]);
    expect(off.inactivityAvailable).toBe(false);
  });

  it("does not call anyone inactive while the access log looks stale, and says so", async () => {
    load.loadCoverState.mockResolvedValue(state({ accessLogNewestOn: "2026-10-20", leaves: [], lastSeenOn: new Map([[7, "2026-10-14"]]) }));
    const stale = await loadAbsences(conn, { accessLoggingOn: true, inactivityDays: 3, now: NOW });
    expect(stale.absent).toEqual([]);
    expect(stale.inactivityAvailable).toBe(false);
    expect(stale.inactivityReason).toBe("stale");
  });

  it("reads the switches from the environment when it is not told", async () => {
    const saved = process.env.ACCESS_LOG_ENABLED;
    process.env.ACCESS_LOG_ENABLED = "false";
    try {
      expect((await loadAbsences(conn, { now: NOW })).inactivityAvailable).toBe(false);
      expect(load.loadCoverState).toHaveBeenCalledWith(conn, "2026-10-26", false);
    } finally {
      if (saved === undefined) delete process.env.ACCESS_LOG_ENABLED;
      else process.env.ACCESS_LOG_ENABLED = saved;
    }
  });
});

describe("loadLiveView", () => {
  it("plans each item of the people who are away", async () => {
    const view = await loadLiveView(conn, { accessLoggingOn: true, inactivityDays: 3, now: NOW });
    expect(view.items).toHaveLength(1);
    expect(view.plan.entries).toHaveLength(1);
    expect(view.plan.entries[0]).toMatchObject({ action: "reassigned", reasonCode: "due_before_return" });
    expect(inventory.loadInventory.mock.calls[0][1].absent.map((person: { userId: number }) => person.userId)).toEqual([1]);
  });

  it("reads no work, and no ledger, when nobody is away", async () => {
    load.loadCoverState.mockResolvedValue(state({ leaves: [] }));
    const view = await loadLiveView(conn, { accessLoggingOn: true, inactivityDays: 3, now: NOW });
    expect(view.plan.entries).toEqual([]);
    expect(inventory.loadInventory).not.toHaveBeenCalled();
    expect(store.latestActionsByItem).not.toHaveBeenCalled();
  });

  it("reads the ledger only when there is work to compare it with", async () => {
    inventory.loadInventory.mockResolvedValue([]);
    await loadLiveView(conn, { accessLoggingOn: true, inactivityDays: 3, now: NOW });
    expect(store.latestActionsByItem).not.toHaveBeenCalled();
  });
});
