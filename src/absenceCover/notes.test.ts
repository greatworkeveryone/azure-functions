/// <reference types="jest" />
import { loadJobCoverNotes } from "./notes";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));
const db = jest.requireMock("../db") as { executeQuery: jest.Mock };

describe("loadJobCoverNotes", () => {
  beforeEach(() => db.executeQuery.mockReset());

  it("asks nothing for no jobs", async () => {
    expect(await loadJobCoverNotes({} as never, [], "2026-10-26")).toEqual([]);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("selects the latest hand-over per job that is still with the cover and whose absence has not ended", async () => {
    db.executeQuery.mockResolvedValue([{ AwayName: "Fay Facilities", CoverName: "Max Manager", ItemId: "12", ReturnDate: "2026-11-02" }, { AwayName: "Sam", CoverName: "Mia", ItemId: "13", ReturnDate: null }]);
    const notes = await loadJobCoverNotes({} as never, [12, 13], "2026-10-26");
    expect(notes).toEqual([
      { awayName: "Fay Facilities", coverName: "Max Manager", itemId: "12", returnDate: "2026-11-02" },
      { awayName: "Sam", coverName: "Mia", itemId: "13", returnDate: null },
    ]);
    const sql = String(db.executeQuery.mock.calls[0][1]);
    expect(sql).toContain("c.Action = N'reassigned' AND c.DryRun = 0");
    expect(sql).toContain("j.AssignedToUserID = c.ToUserId");
    expect(sql).toContain("SELECT MAX(x.CoverActionId)");
    expect(sql).toContain("c.ReturnDate IS NULL OR c.ReturnDate > @Today");
    expect(db.executeQuery.mock.calls[0][2].map((param: { value: unknown }) => param.value).slice(0, 2)).toEqual(["12", "13"]);
  });
});
