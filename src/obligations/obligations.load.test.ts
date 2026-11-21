/// <reference types="jest" />
// Loading is bounded (the same number of queries for five rows or five thousand), a source that cannot be read is
// reported, and the per-source cap says truthfully how many rows it left out.

import { deriveObligations, dedupe } from "./derive";
import { loadObligations } from "./load";
import { mondayOf } from "./sources/timesheets";
import { timesheetsSource } from "./sources/timesheets";
import { world, viewerOf } from "../__tests__/fixtures/obligationsWorld";
import type { Candidate } from "./types";

jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn(), timer: jest.fn() } }));
jest.mock("../db", () => ({ executeQuery: jest.fn(), SqlRow: undefined }));
jest.mock("../approvalAuthority-db", () => ({
  darwinToday: () => "2026-11-18",
  loadApprovalFacts: jest.fn().mockResolvedValue({ directorThreshold: 50000, isResidence: false, limits: [], residenceApprovers: [], residenceDirectorFallback: true, today: "2026-11-18" }),
}));
jest.mock("../escalation/store", () => ({ ...jest.requireActual("../escalation/store"), listActiveUsers: jest.fn().mockResolvedValue([]) }));
jest.mock("../peopleWorkflow", () => ({ loadPeople: jest.fn().mockResolvedValue({ links: [], staff: [] }) }));
jest.mock("../jobStepFacts", () => ({ ...jest.requireActual("../jobStepFacts"), withJobSteps: jest.fn(async (_c: unknown, rows: unknown[]) => rows) }));

const { executeQuery } = jest.requireMock("../db") as { executeQuery: jest.Mock };

describe("loading", () => {
  it("asks the database the same number of questions however long the lists are", async () => {
    executeQuery.mockReset().mockResolvedValue([]);
    await loadObligations({} as never);
    const empty = executeQuery.mock.calls.length;
    const rows = Array.from({ length: 800 }, (_, index) => ({ JobID: index, Status: "New", Title: "x" }));
    executeQuery.mockReset().mockResolvedValue(rows);
    await loadObligations({} as never).catch(() => undefined);
    expect(executeQuery.mock.calls.length).toBe(empty);
  });

  it("reports a source it could not read rather than leaving it out silently", async () => {
    executeQuery.mockReset().mockImplementation(async (_c: unknown, sql: string) => {
      if (sql.includes("dbo.LeaveRequests")) throw new Error("boom");
      return [];
    });
    const loaded = await loadObligations({} as never);
    expect(loaded.unavailable).toEqual(["leave"]);
    expect(loaded.sources.map((source) => source.adapter.name)).not.toContain("leave");
  });
});

describe("the cap and the dedupe", () => {
  const candidate = (id: string, group: Candidate["group"], key = id): Candidate => ({ canAct: group !== "waiting", chasedNext: null, dueAt: null, from: null, group, id, key, kind: "job", link: "/", place: null, subject: id, verb: "x", waitingSince: null });

  it("lists at most the cap per source and group, and counts the rest", () => {
    const rows = Array.from({ length: 7 }, (_, index) => candidate(`job:${index}`, "do"));
    const adapter = { derive: () => rows, load: async () => null, name: "jobs" };
    const { ctx } = world();
    const list = deriveObligations([{ adapter, facts: null }], viewerOf("facilities"), ctx, [], 3);
    expect({ more: list.more.do, shown: list.items.length, total: list.totals.do }).toEqual({ more: 4, shown: 3, total: 7 });
  });

  it("counts one thing once, in the group that asks most of the person", () => {
    const kept = dedupe([candidate("escalation:1", "waiting", "job:5"), candidate("job:5", "do", "job:5")]);
    expect(kept.map((row) => row.group)).toEqual(["do"]);
  });
});

describe("a person's own timesheet", () => {
  const viewer = viewerOf("facilities");
  const derive = (today: string, rows: unknown[]) => timesheetsSource.derive(rows as never, viewer, { ...world().ctx, today });

  it("is asked for from Thursday, not before", () => {
    expect(mondayOf("2026-11-19")).toEqual({ monday: "2026-11-16", weekday: 4 });
    expect(derive("2026-11-18", [])).toEqual([]);
    expect(derive("2026-11-19", []).map((row) => [row.group, row.id])).toEqual([["do", "timesheet:week:2026-11-16"]]);
  });

  it("is a thing to do when started and never sent, and a thing waited on once sent", () => {
    const sheet = (ready: boolean) => ({ Approved: false, ReadyForApproval: ready, Role: "facilities", TimesheetID: 9, UserDisplayName: "Fran Officer", UserID: "o2", WeekStart: "2026-11-09" });
    expect(derive("2026-11-18", [sheet(false)]).map((row) => row.group)).toEqual(["do"]);
    expect(derive("2026-11-18", [sheet(true)]).map((row) => [row.group, row.with])).toEqual([["waiting", "a facilities manager"]]);
  });
});
