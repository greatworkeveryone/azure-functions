/// <reference types="jest" />
import { getAdapter, registeredSubjectTypes } from "./registry";
import "./index";
import { ABSENCE_COVER_SUBJECT, absenceCoverAdapter } from "./absenceCover";

jest.mock("../../db", () => ({ executeQuery: jest.fn() }));
const db = jest.requireMock("../../db") as { executeQuery: jest.Mock };
const conn = {} as never;

describe("the absence_cover adapter", () => {
  beforeEach(() => db.executeQuery.mockReset());

  it("is registered with the others", () => {
    expect(registeredSubjectTypes()).toContain(ABSENCE_COVER_SUBJECT);
    expect(getAdapter("absence_cover")).toBe(absenceCoverAdapter);
  });

  it("describes a move to its cover in one line, naming who is away", async () => {
    db.executeQuery.mockResolvedValue([{ FromName: "Fay Facilities", ItemId: "12", ItemLabel: "Job #12 · Leaking roof", ItemType: "job", ReasonText: "x", ReturnDate: "2026-11-02" }]);
    const summary = await absenceCoverAdapter.loadSummary(conn, "901");
    expect(summary).toEqual({
      buildingId: null,
      context: { coverActionId: 901, fromName: "Fay Facilities", itemId: "12", itemType: "job", returnDate: "2026-11-02" },
      summary: "Covering for Fay Facilities: Job #12 · Leaking roof",
    });
    expect(String(db.executeQuery.mock.calls[0][1])).toContain("c.Action IN (N'reassigned', N'escalated')");
  });

  it("finds no summary for a suggestion, a missing row or a bad id", async () => {
    db.executeQuery.mockResolvedValue([]);
    expect(await absenceCoverAdapter.loadSummary(conn, "901")).toBeNull();
    expect(await absenceCoverAdapter.loadSummary(conn, "not-a-number")).toBeNull();
  });

  it("stays active until the move is taken back", async () => {
    db.executeQuery.mockResolvedValue([{ Active: 1 }]);
    expect(await absenceCoverAdapter.isConditionActive(conn, { policyKey: "cover.moved", subjectId: "901", subjectType: "absence_cover" }, new Date())).toBe(true);
    db.executeQuery.mockResolvedValue([{ Active: 0 }]);
    expect(await absenceCoverAdapter.isConditionActive(conn, { policyKey: "cover.moved", subjectId: "901", subjectType: "absence_cover" }, new Date())).toBe(false);
    expect(await absenceCoverAdapter.isConditionActive(conn, { policyKey: "cover.moved", subjectId: "x", subjectType: "absence_cover" }, new Date())).toBe(false);
  });

  it("opens the item the move was about, and falls back to the Covering screen", () => {
    expect(absenceCoverAdapter.deepLink("901", { context: { deepLink: "/jobs?jobId=12" }, policyKey: "cover.moved" })).toBe("/jobs?jobId=12");
    expect(absenceCoverAdapter.deepLink("901", { context: { deepLink: "https://evil.example" }, policyKey: "cover.moved" })).toBe("/covering");
    expect(absenceCoverAdapter.deepLink("901")).toBe("/covering");
  });

  it("is visible to people who work in Floorplan, not admin or a baseline user", () => {
    const viewer = (role: string) => absenceCoverAdapter.visibleTo({ name: "x", roles: [role], userId: 1 }, { policyKey: "cover.moved", subjectId: "1", subjectType: "absence_cover" });
    for (const role of ["facilities", "facilities_manager", "accounts", "accounts_manager", "cfo", "director"]) expect(viewer(role)).toBe(true);
    for (const role of ["admin", "user"]) expect(viewer(role)).toBe(false);
  });
});
