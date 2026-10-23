/// <reference types="jest" />
import { levelRemoval, REMOVAL_ROW_BUDGET_BYTES, removalSnapshots, roomRemoval } from "./inspectionRemovalLedger";
import type { RemovedPhoto, RemovedRoom } from "./inspectionRemovalLedger";
import { LEDGER_MAX_SNAPSHOT_BYTES, snapshotBytes } from "./ledger/validate";

const photo = (n: number): RemovedPhoto => ({ blobName: `inspections/7/blob-${n}.jpg`, fileName: `photo-${n}.jpg`, id: `att-${n}` });

describe("removalSnapshots", () => {
  it("keeps the budget inside the ledger's cap", () => {
    expect(REMOVAL_ROW_BUDGET_BYTES).toBeLessThan(LEDGER_MAX_SNAPSHOT_BYTES);
    expect(REMOVAL_ROW_BUDGET_BYTES).toBeGreaterThan(LEDGER_MAX_SNAPSHOT_BYTES / 2);
  });

  it("writes a small removal as its whole self in one row", () => {
    const removal = roomRemoval({ description: "", id: "rm-1", levelId: "lv-1", levelName: "Ground", name: "Lobby" }, [
      { attachments: [photo(1)], description: "Crack", id: "pt-1" },
    ]);
    expect(removalSnapshots(removal)).toEqual([removal.whole]);
  });

  it("spills a room list too long for the summary row into further rows, losing no room", () => {
    const rooms: RemovedRoom[] = Array.from({ length: 600 }, (_, i) => ({
      description: "d".repeat(300),
      id: `rm-${i}`,
      name: `Room ${i} ${"n".repeat(150)}`,
      points: i === 599 ? [{ attachments: [photo(1)], description: "Last", id: "pt-last" }] : [],
    }));
    const rows = removalSnapshots(levelRemoval({ id: "lv-1", name: "Ground" }, rooms));

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
