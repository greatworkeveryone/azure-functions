/// <reference types="jest" />
import {
  levelRemoval,
  photoRemoval,
  pointRemoval,
  REMOVAL_ROW_BUDGET_BYTES,
  removalSnapshots,
  roomRemoval,
} from "./inspectionRemovalLedger";
import type { AddedStamp, RemovedPhoto, RemovedPoint, RemovedRoom } from "./inspectionRemovalLedger";
import { MAX_POINT_DESCRIPTION_LENGTH } from "./inspectionLimits";
import { LEDGER_MAX_SNAPSHOT_BYTES, snapshotBytes } from "./ledger/validate";

const photo = (n: number): RemovedPhoto => ({
  blobName: `inspections/7/blob-${n}.jpg`,
  fileName: `photo-${n}.jpg`,
  id: `att-${n}`,
  uploadedAt: "2026-10-20T01:02:03.000Z",
  uploadedById: "oid-uploader",
  uploadedByName: "Una Uploader",
});
const stamp = (name = "Ada Added"): AddedStamp => ({ addedAt: "2026-10-19T22:30:00.000Z", addedById: "oid-adder", addedByName: name });
const point = (id: string, description: string, photos: RemovedPhoto[] = []): RemovedPoint => ({ ...stamp(), attachments: photos, description, id });

describe("removalSnapshots", () => {
  it("keeps the budget inside the ledger's cap", () => {
    expect(REMOVAL_ROW_BUDGET_BYTES).toBeLessThan(LEDGER_MAX_SNAPSHOT_BYTES);
    expect(REMOVAL_ROW_BUDGET_BYTES).toBeGreaterThan(LEDGER_MAX_SNAPSHOT_BYTES / 2);
  });

  it("writes a small removal as its whole self in one row", () => {
    const removal = roomRemoval({ ...stamp(), description: "", id: "rm-1", levelId: "lv-1", levelName: "Ground", name: "Lobby" }, [
      point("pt-1", "Crack", [photo(1)]),
    ]);
    expect(removalSnapshots(removal)).toEqual([removal.whole]);
  });

  it("spills a room list too long for the summary row into further rows, losing no room", () => {
    const rooms: RemovedRoom[] = Array.from({ length: 600 }, (_, i) => ({
      ...stamp(),
      description: "d".repeat(300),
      id: `rm-${i}`,
      name: `Room ${i} ${"n".repeat(150)}`,
      points: i === 599 ? [point("pt-last", "Last", [photo(1)])] : [],
    }));
    const rows = removalSnapshots(levelRemoval({ addedAt: "2026-10-19T00:00:00.000Z", id: "lv-1", name: "Ground" }, rooms, []));

    expect(rows.length).toBeGreaterThan(2);
    for (const row of rows) expect(snapshotBytes(row)).toBeLessThanOrEqual(REMOVAL_ROW_BUDGET_BYTES);
    expect(rows.map((row) => row.part)).toEqual(rows.map((_, i) => i + 1));
    expect(rows.every((row) => row.parts === rows.length)).toBe(true);
    const listed = rows.flatMap((row) => (row.rooms as { id: string }[] | undefined) ?? []).map((room) => room.id);
    expect(listed).toEqual(rooms.map((room) => room.id));
    const points = rows.flatMap((row) => (row.points as { id: string }[] | undefined) ?? []);
    expect(points.map((point) => point.id)).toEqual(["pt-last"]);
  });
});

describe("who added what, and when (UX fix round 2, bug 6)", () => {
  it("a point removal's row names who added the point and who uploaded each photo, with the times", () => {
    const [row] = removalSnapshots(
      pointRemoval({ ...stamp(), description: "Cracked", id: "pt-1", levelName: "Ground", roomId: "rm-1", roomName: "Lobby" }, [photo(1)]),
    );
    expect(row).toMatchObject({ addedAt: "2026-10-19T22:30:00.000Z", addedById: "oid-adder", addedByName: "Ada Added" });
    expect((row.attachments as RemovedPhoto[])[0]).toMatchObject({
      uploadedAt: "2026-10-20T01:02:03.000Z",
      uploadedById: "oid-uploader",
      uploadedByName: "Una Uploader",
    });
  });

  it("a room removal carries the room's own stamp and each point's", () => {
    const [row] = removalSnapshots(
      roomRemoval({ ...stamp("Rita Room"), description: "", id: "rm-1", levelId: "lv-1", levelName: "Ground", name: "Lobby" }, [point("pt-1", "Crack")]),
    );
    expect(row).toMatchObject({ roomAddedAt: "2026-10-19T22:30:00.000Z", roomAddedById: "oid-adder", roomAddedByName: "Rita Room" });
    expect((row.points as RemovedPoint[])[0]).toMatchObject({ addedByName: "Ada Added" });
  });

  it("a level removal carries the level's time, its contributors and each room's stamp", () => {
    const [row] = removalSnapshots(
      levelRemoval(
        { addedAt: "2026-10-18T00:00:00.000Z", id: "lv-1", name: "Ground" },
        [{ ...stamp("Rita Room"), description: "", id: "rm-1", name: "Lobby", points: [] }],
        [{ id: "oid-1", name: "Ada" }, { id: "oid-2", name: "Bo" }],
      ),
    );
    expect(row).toMatchObject({
      contributors: [{ id: "oid-1", name: "Ada" }, { id: "oid-2", name: "Bo" }],
      levelAddedAt: "2026-10-18T00:00:00.000Z",
    });
    expect((row.rooms as { addedByName: string }[])[0].addedByName).toBe("Rita Room");
  });

  it("a split holds every contributor, room stamp, point stamp and photo stamp exactly once", () => {
    const contributors = Array.from({ length: 400 }, (_, i) => ({ id: `oid-${i}`, name: `Contributor ${i} ${"n".repeat(180)}` }));
    const rooms: RemovedRoom[] = [0, 1].map((r) => ({
      ...stamp(`Room adder ${r}`),
      description: "",
      id: `rm-${r}`,
      name: `Room ${r}`,
      points: [0, 1].map((p) => point(`pt-${r}${p}`, `Finding ${r}.${p}`, Array.from({ length: 300 }, (_, i) => photo(r * 10000 + p * 1000 + i)))),
    }));
    const rows = removalSnapshots(levelRemoval({ addedAt: "2026-10-18T00:00:00.000Z", id: "lv-1", name: "Ground" }, rooms, contributors));

    expect(rows.length).toBeGreaterThan(4);
    for (const row of rows) expect(snapshotBytes(row)).toBeLessThanOrEqual(REMOVAL_ROW_BUDGET_BYTES);
    expect(rows.map((row) => row.part)).toEqual(rows.map((_, i) => i + 1));
    expect(rows.every((row) => row.parts === rows.length)).toBe(true);

    const listedContributors = rows.flatMap((row) => (row.contributors as { id: string }[] | undefined) ?? []);
    expect(listedContributors.map((c) => c.id)).toEqual(contributors.map((c) => c.id));
    const listedRooms = rows.flatMap((row) => (row.rooms as { addedByName: string; id: string }[] | undefined) ?? []);
    expect(listedRooms.map((room) => [room.id, room.addedByName])).toEqual([["rm-0", "Room adder 0"], ["rm-1", "Room adder 1"]]);
    const points = rows.flatMap((row) => (row.points as (RemovedPoint & { continued?: true })[] | undefined) ?? []);
    const withText = points.filter((p) => !p.continued);
    expect(withText.map((p) => [p.id, p.addedByName, p.addedAt])).toEqual(
      rooms.flatMap((room) => room.points.map((p) => [p.id, "Ada Added", "2026-10-19T22:30:00.000Z"])),
    );
    const photos = points.flatMap((p) => p.attachments);
    expect(photos).toHaveLength(1200);
    expect(new Set(photos.map((p) => p.id)).size).toBe(1200);
    expect(photos.every((p) => p.uploadedByName === "Una Uploader" && p.uploadedAt === "2026-10-20T01:02:03.000Z")).toBe(true);
  });

  it("a photo removal is one row holding the point, the file names and who uploaded it and when", () => {
    const removal = photoRemoval({ ...photo(5), levelName: "Ground", pointId: "pt-1", roomId: "rm-1", roomName: "Lobby" });
    expect(removal.action).toBe("inspection.photo_removed");
    expect(removalSnapshots(removal)).toEqual([
      {
        attachmentId: "att-5",
        blobName: "inspections/7/blob-5.jpg",
        fileName: "photo-5.jpg",
        levelName: "Ground",
        pointId: "pt-1",
        roomId: "rm-1",
        roomName: "Lobby",
        uploadedAt: "2026-10-20T01:02:03.000Z",
        uploadedById: "oid-uploader",
        uploadedByName: "Una Uploader",
      },
    ]);
  });
});

describe("a removal is never too big to log once point text is capped (UX fix round 2, bug 5)", () => {
  // Control characters are the worst case for JSON: each becomes a six-byte escape.
  const WORST_TEXT = "\u0001".repeat(MAX_POINT_DESCRIPTION_LENGTH);
  const WORST_NAME = "\u0001".repeat(200);
  const worstStamp: AddedStamp = { addedAt: "2026-10-19T22:30:00.000Z", addedById: WORST_NAME, addedByName: WORST_NAME };
  const worstPhoto = (n: number): RemovedPhoto => ({
    blobName: `inspections/${"\u0001".repeat(480)}${n}`,
    fileName: "\u0001".repeat(500),
    id: `att-${n}`,
    uploadedAt: "2026-10-20T01:02:03.000Z",
    uploadedById: WORST_NAME,
    uploadedByName: WORST_NAME,
  });
  const worstPoint = (id: string, photos: number): RemovedPoint => ({
    ...worstStamp,
    attachments: Array.from({ length: photos }, (_, i) => worstPhoto(i)),
    description: WORST_TEXT,
    id,
  });

  it("splits a capped-text point with hundreds of worst-case photos into rows that all fit", () => {
    const rows = removalSnapshots(
      pointRemoval(
        { ...worstStamp, description: WORST_TEXT, id: "pt-1", levelName: "L".repeat(100), roomId: "rm-1", roomName: "\u0001".repeat(200) },
        worstPoint("pt-1", 300).attachments,
      ),
    );
    expect(rows.length).toBeGreaterThan(2);
    for (const row of rows) expect(snapshotBytes(row)).toBeLessThanOrEqual(REMOVAL_ROW_BUDGET_BYTES);
  });

  it("splits a level of worst-case rooms, points and contributors into rows that all fit", () => {
    const rooms: RemovedRoom[] = Array.from({ length: 6 }, (_, r) => ({
      ...worstStamp,
      description: "\u0001".repeat(500),
      id: `rm-${r}`,
      name: "\u0001".repeat(200),
      points: [worstPoint(`pt-${r}-a`, 40), worstPoint(`pt-${r}-b`, 0)],
    }));
    const contributors = Array.from({ length: 60 }, (_, i) => ({ id: `${"\u0001".repeat(190)}${i}`, name: "\u0001".repeat(200) }));
    const rows = removalSnapshots(levelRemoval({ addedAt: "2026-10-18T00:00:00.000Z", id: "lv-1", name: "\u0001".repeat(100) }, rooms, contributors));

    expect(rows.length).toBeGreaterThan(2);
    for (const row of rows) expect(snapshotBytes(row)).toBeLessThanOrEqual(REMOVAL_ROW_BUDGET_BYTES);
    const texts = rows.flatMap((row) => (row.points as RemovedPoint[] | undefined) ?? []).filter((p) => p.description !== undefined);
    expect(texts).toHaveLength(12);
  });

  it("the cap leaves a point's text well inside one row", () => {
    expect(snapshotBytes({ description: WORST_TEXT })).toBeLessThan(REMOVAL_ROW_BUDGET_BYTES / 1.5);
  });

  it("a photo removal is always one row, whatever the names", () => {
    const removal = photoRemoval({ ...worstPhoto(1), levelName: "\u0001".repeat(100), pointId: "p".repeat(36), roomId: "r".repeat(36), roomName: "\u0001".repeat(200) });
    expect(removalSnapshots(removal)).toHaveLength(1);
    expect(snapshotBytes(removal.whole)).toBeLessThan(REMOVAL_ROW_BUDGET_BYTES);
  });
});
