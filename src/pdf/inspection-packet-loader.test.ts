import { loadInspectionPacketInputs } from "./inspection-packet-loader";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));
jest.mock("../blob-storage", () => ({ downloadBlob: jest.fn() }));

import { executeQuery } from "../db";
import { downloadBlob } from "../blob-storage";

const mockQuery = executeQuery as unknown as jest.Mock;
const mockDownload = downloadBlob as unknown as jest.Mock;

type Row = Record<string, unknown>;
interface Fixture {
  inspection?: Row[];
  levels?: Row[];
  rooms?: Row[];
  points?: Row[];
  attachments?: Row[];
  raisedJobs?: Row[];
}

// Route each query to canned rows by matching on the SQL text, so the test
// doesn't depend on call order.
function wire(fixture: Fixture) {
  mockQuery.mockImplementation((_conn: unknown, sql: string) => {
    if (sql.includes("FROM dbo.Inspections")) return Promise.resolve(fixture.inspection ?? []);
    if (sql.includes("FROM dbo.InspectionLevels")) return Promise.resolve(fixture.levels ?? []);
    if (sql.includes("FROM dbo.InspectionRooms")) return Promise.resolve(fixture.rooms ?? []);
    if (sql.includes("FROM dbo.InspectionPoints")) return Promise.resolve(fixture.points ?? []);
    if (sql.includes("FROM dbo.InspectionAttachments")) return Promise.resolve(fixture.attachments ?? []);
    if (sql.includes("FROM dbo.InspectionRaisedJobs")) return Promise.resolve(fixture.raisedJobs ?? []);
    return Promise.resolve([]);
  });
}

const CREATED = new Date("2026-07-01T00:00:00.000Z");
const COMPLETED = new Date("2026-07-05T00:00:00.000Z");

const BASE_HEADER: Row = {
  Id: 42,
  BuildingName: "Riverside Tower",
  Title: "Quarterly walkthrough",
  Status: "complete",
  CreatedAt: CREATED,
  CreatedByName: "Jane Doe",
  CompletedAt: COMPLETED,
  CompletedByName: "Jane Doe",
};

const BASE_FIXTURE: Fixture = {
  inspection: [BASE_HEADER],
  levels: [{ Id: "lvl-1", Name: "Level 2" }],
  rooms: [{ Id: "room-1", LevelId: "lvl-1", Name: "Kitchen" }],
  points: [
    {
      Id: "pt-1",
      RoomId: "room-1",
      Description: "Water damage",
      AddedByName: "Jane Doe",
      AddedAt: CREATED,
    },
  ],
  attachments: [
    { PointId: "pt-1", BlobName: "inspections/aaa", FileName: "a.jpg" },
    { PointId: "pt-1", BlobName: "inspections/bbb", FileName: "b.jpg" },
  ],
  raisedJobs: [{ PointId: "pt-1", JobId: 33 }],
};

function wireQueries() {
  wire(BASE_FIXTURE);
}

beforeEach(() => jest.clearAllMocks());

describe("loadInspectionPacketInputs", () => {
  it("assembles the nested structure with totals and photo bytes", async () => {
    wireQueries();
    mockDownload.mockResolvedValue(Buffer.from("img"));

    const input = await loadInspectionPacketInputs({} as never, 42);

    expect(input).not.toBeNull();
    expect(input!.buildingName).toBe("Riverside Tower");
    expect(input!.totals).toEqual({ levels: 1, rooms: 1, issues: 1, jobs: 1 });
    const point = input!.levels[0].rooms[0].points[0];
    expect(point.raisedJobIds).toEqual([33]);
    expect(point.photos).toHaveLength(2);
    expect(point.photos[0].bytes).toEqual(Buffer.from("img"));
  });

  it("returns null when the inspection does not exist", async () => {
    mockQuery.mockResolvedValue([]);
    const input = await loadInspectionPacketInputs({} as never, 999);
    expect(input).toBeNull();
  });

  it("skips a photo whose blob fails to download", async () => {
    wireQueries();
    // Reject by blob name (not call order) so the test doesn't depend on the
    // order the loader happens to fire its downloads in.
    mockDownload.mockImplementation((blobName: string) =>
      blobName === "inspections/bbb"
        ? Promise.reject(new Error("missing blob"))
        : Promise.resolve(Buffer.from("img")),
    );

    const input = await loadInspectionPacketInputs({} as never, 42);
    expect(input!.levels[0].rooms[0].points[0].photos).toHaveLength(1);
  });

  it("handles a zero-level inspection and issues no child queries", async () => {
    wire({ inspection: [BASE_HEADER], levels: [] });

    const input = await loadInspectionPacketInputs({} as never, 42);

    expect(input).not.toBeNull();
    expect(input!.levels).toEqual([]);
    expect(input!.totals).toEqual({ levels: 0, rooms: 0, issues: 0, jobs: 0 });
    const sqlIssued = (needle: string) =>
      mockQuery.mock.calls.some(([, sql]) => (sql as string).includes(needle));
    expect(sqlIssued("FROM dbo.InspectionRooms")).toBe(false);
    expect(sqlIssued("FROM dbo.InspectionPoints")).toBe(false);
    expect(sqlIssued("FROM dbo.InspectionAttachments")).toBe(false);
  });

  it("counts multiple rooms/points and dedups a job shared across points", async () => {
    wire({
      inspection: [BASE_HEADER],
      levels: [{ Id: "lvl-1", Name: "Level 2" }],
      rooms: [
        { Id: "room-1", LevelId: "lvl-1", Name: "Kitchen" },
        { Id: "room-2", LevelId: "lvl-1", Name: "Bathroom" },
      ],
      points: [
        { Id: "pt-1", RoomId: "room-1", Description: "A", AddedByName: "Jane Doe", AddedAt: CREATED },
        { Id: "pt-2", RoomId: "room-1", Description: "B", AddedByName: "Jane Doe", AddedAt: CREATED },
        { Id: "pt-3", RoomId: "room-2", Description: "C", AddedByName: "Jane Doe", AddedAt: CREATED },
        { Id: "pt-4", RoomId: "room-2", Description: "D", AddedByName: "Jane Doe", AddedAt: CREATED },
      ],
      attachments: [],
      // Same JobId raised from two different points — the Set must dedup it.
      raisedJobs: [
        { PointId: "pt-1", JobId: 33 },
        { PointId: "pt-3", JobId: 33 },
      ],
    });

    const input = await loadInspectionPacketInputs({} as never, 42);
    expect(input!.totals).toEqual({ levels: 1, rooms: 2, issues: 4, jobs: 1 });
  });

  it("falls back to 'Inspection #<id>' when the title is null", async () => {
    wire({ inspection: [{ ...BASE_HEADER, Title: null }], levels: [] });

    const input = await loadInspectionPacketInputs({} as never, 42);
    expect(input!.title).toBe("Inspection #42");
  });

  // Rooms seed with a blank placeholder point (persisted to InspectionPoints).
  // The read-only Summary modal hides these via visibleInspectionLevels; the
  // PDF must match, so the loader mirrors the same filtering.
  it("excludes a blank-description point from the tree and from totals.issues", async () => {
    wire({
      inspection: [BASE_HEADER],
      levels: [{ Id: "lvl-1", Name: "Level 2" }],
      rooms: [{ Id: "room-1", LevelId: "lvl-1", Name: "Kitchen" }],
      points: [
        { Id: "pt-1", RoomId: "room-1", Description: "Water damage", AddedByName: "Jane Doe", AddedAt: CREATED },
        { Id: "pt-2", RoomId: "room-1", Description: "", AddedByName: "Jane Doe", AddedAt: CREATED },
      ],
      attachments: [],
      raisedJobs: [],
    });

    const input = await loadInspectionPacketInputs({} as never, 42);
    const points = input!.levels[0].rooms[0].points;
    expect(points).toHaveLength(1);
    expect(points[0].description).toBe("Water damage");
    expect(input!.totals.issues).toBe(1);
  });

  it("drops a room whose only point is blank, and the level left with no rooms", async () => {
    wire({
      inspection: [BASE_HEADER],
      levels: [
        { Id: "lvl-1", Name: "Level 2" },
        { Id: "lvl-2", Name: "Level 3" },
      ],
      rooms: [
        { Id: "room-1", LevelId: "lvl-1", Name: "Kitchen" },
        { Id: "room-2", LevelId: "lvl-2", Name: "Bathroom" },
      ],
      points: [
        { Id: "pt-1", RoomId: "room-1", Description: "Cracked tile", AddedByName: "Jane Doe", AddedAt: CREATED },
        // Bathroom's only point is a blank placeholder — room and its level go.
        { Id: "pt-2", RoomId: "room-2", Description: "   ", AddedByName: "Jane Doe", AddedAt: CREATED },
      ],
      attachments: [],
      raisedJobs: [],
    });

    const input = await loadInspectionPacketInputs({} as never, 42);
    expect(input!.levels).toHaveLength(1);
    expect(input!.levels[0].name).toBe("Level 2");
    expect(input!.levels.some((l) => l.name === "Level 3")).toBe(false);
    expect(input!.levels[0].rooms).toHaveLength(1);
    expect(input!.levels[0].rooms[0].name).toBe("Kitchen");
    expect(input!.totals).toEqual({ levels: 1, rooms: 1, issues: 1, jobs: 0 });
  });

  it("keeps a room with a real point but omits its blank sibling", async () => {
    wire({
      inspection: [BASE_HEADER],
      levels: [{ Id: "lvl-1", Name: "Level 2" }],
      rooms: [{ Id: "room-1", LevelId: "lvl-1", Name: "Kitchen" }],
      points: [
        { Id: "pt-1", RoomId: "room-1", Description: "   ", AddedByName: "Jane Doe", AddedAt: CREATED },
        { Id: "pt-2", RoomId: "room-1", Description: "Leaking tap", AddedByName: "Jane Doe", AddedAt: CREATED },
      ],
      attachments: [],
      raisedJobs: [],
    });

    const input = await loadInspectionPacketInputs({} as never, 42);
    const room = input!.levels[0].rooms[0];
    expect(room.points).toHaveLength(1);
    expect(room.points[0].description).toBe("Leaking tap");
    expect(input!.totals).toEqual({ levels: 1, rooms: 1, issues: 1, jobs: 0 });
  });
});
