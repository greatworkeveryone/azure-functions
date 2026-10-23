// The decision-ledger rows for taking a photo, a point, a room or a whole level
// off a draft inspection. Everything removed goes in `before`, so a removal can
// be put back by hand: the text, the photo records (the files themselves stay in
// storage), and who added each item and when (points, rooms, photos, and the
// people who contributed to a level). The ledger caps a snapshot, and a level
// with hundreds of photos is larger than that cap: such a removal is written as
// several rows of the same action, in the caller's transaction, sharing one
// correlation id. If any row fails, the op is rejected and nothing is removed
// (inspections.ts).
//
// One row when it fits (the shape the first version wrote). When it does not:
//   row 1        the summary: ids, names, counts, `part: 1`, `parts: n`, and for
//                a level the room list (id, name, description, who added it, point and photo counts)
//   next rows    more of the room list, then the level's contributors, when they do not fit
//   last rows    `part: k`, `parts: n` and a slice of the points, each with its
//                photo records; a point too big for a row has its photo records
//                spread over consecutive rows, the later slices marked `continued`
// Every point, photo record, room and contributor appears in exactly one row.
//
// A removal is never refused for size. Splitting works because every piece that
// goes into a row whole is far smaller than a row: a point's text is capped at
// 5,000 characters on add and update (inspectionLimits.ts; about 30 KB of JSON
// at worst, against a 56 KiB row budget), rooms hold at most 500 characters of
// text and a 200-character name, a level name is at most 100 characters, a
// photo record is two names of at most 500 characters, and a contributor is a
// 200-character id and name. Photo records, the only unbounded part, are what a
// point's slices are cut from.

import { newCorrelationId, record } from "./ledger";
import { assertLedgerEntry, LEDGER_MAX_SNAPSHOT_BYTES, snapshotBytes } from "./ledger/validate";
import type { LedgerActor, LedgerEntryInput, LedgerTx } from "./ledger";

/** When and by whom something was added, as the table holds it (ISO text; null if the row has none). */
export type AddedStamp = { addedAt: string | null; addedById: string | null; addedByName: string | null };
export type RemovedPhoto = {
  blobName: string;
  fileName: string;
  id: string;
  uploadedAt: string | null;
  uploadedById: string | null;
  uploadedByName: string | null;
};
export type RemovedPoint = AddedStamp & { attachments: RemovedPhoto[]; description: string; id: string };
export type RemovedRoom = AddedStamp & { description: string; id: string; name: string; points: RemovedPoint[] };
export type RemovedContributor = { id: string; name: string };

type Json = Record<string, unknown>;
type SplitPoint = Partial<AddedStamp> & {
  attachments: RemovedPhoto[];
  continued?: true;
  description?: string;
  id: string;
  roomId: string;
};

/** Rows are packed to seven eighths of the ledger's own cap, so a field added to
 *  a row later, or a count that gains a digit, cannot tip a full row over it. */
export const REMOVAL_ROW_BUDGET_BYTES = Math.floor((LEDGER_MAX_SNAPSHOT_BYTES / 8) * 7);

// Stand-ins for `part` and `parts` while sizing: the real numbers are never longer.
const WIDEST_COUNT = 99_999;

export interface InspectionRemoval {
  action: "inspection.level_removed" | "inspection.photo_removed" | "inspection.point_removed" | "inspection.room_removed";
  /** Fields every row of a split repeats, so each part names what it belongs to. */
  context: Json;
  /** Level removals: the people recorded as contributors to the level, for rows of their own when split. */
  contributors: RemovedContributor[];
  /** A point's text is in the summary (point removals) rather than with its photo records. */
  pointTextInSummary: boolean;
  points: (RemovedPoint & { roomId: string })[];
  /** Level removals: the rooms, counted, for the summary row. */
  roomList: Json[];
  /** Row 1 of a split: the removal's own fields, counted. */
  summary: Json;
  /** The whole removal in one row, when it fits. */
  whole: Json;
}

export const photoCount = (points: RemovedPoint[]): number =>
  points.reduce((sum, point) => sum + point.attachments.length, 0);

const stamp = (who: AddedStamp): AddedStamp => ({ addedAt: who.addedAt, addedById: who.addedById, addedByName: who.addedByName });

export function pointRemoval(
  point: AddedStamp & { description: string; id: string; levelName: string; roomId: string; roomName: string },
  photos: RemovedPhoto[],
): InspectionRemoval {
  const summary = {
    ...stamp(point),
    attachmentCount: photos.length,
    description: point.description,
    levelName: point.levelName,
    pointId: point.id,
    roomId: point.roomId,
    roomName: point.roomName,
  };
  return {
    action: "inspection.point_removed",
    context: { levelName: point.levelName, pointId: point.id, roomId: point.roomId, roomName: point.roomName },
    contributors: [],
    pointTextInSummary: true,
    points: [{ ...stamp(point), attachments: photos, description: point.description, id: point.id, roomId: point.roomId }],
    roomList: [],
    summary,
    whole: { ...summary, attachments: photos },
  };
}

/** One photo taken off a point (the file stays in storage). A photo record is a few hundred bytes at most, so it is always one row. */
export function photoRemoval(photo: RemovedPhoto & { levelName: string; pointId: string; roomId: string; roomName: string }): InspectionRemoval {
  const whole = {
    attachmentId: photo.id,
    blobName: photo.blobName,
    fileName: photo.fileName,
    levelName: photo.levelName,
    pointId: photo.pointId,
    roomId: photo.roomId,
    roomName: photo.roomName,
    uploadedAt: photo.uploadedAt,
    uploadedById: photo.uploadedById,
    uploadedByName: photo.uploadedByName,
  };
  return {
    action: "inspection.photo_removed",
    context: { attachmentId: photo.id, pointId: photo.pointId },
    contributors: [],
    pointTextInSummary: false,
    points: [],
    roomList: [],
    summary: whole,
    whole,
  };
}

export function roomRemoval(
  room: AddedStamp & { description: string; id: string; levelId: string; levelName: string; name: string },
  points: RemovedPoint[],
): InspectionRemoval {
  const summary = {
    attachmentCount: photoCount(points),
    levelId: room.levelId,
    levelName: room.levelName,
    pointCount: points.length,
    roomAddedAt: room.addedAt,
    roomAddedById: room.addedById,
    roomAddedByName: room.addedByName,
    roomDescription: room.description,
    roomId: room.id,
    roomName: room.name,
  };
  return {
    action: "inspection.room_removed",
    context: { levelId: room.levelId, levelName: room.levelName, roomId: room.id, roomName: room.name },
    contributors: [],
    pointTextInSummary: false,
    points: points.map((point) => ({ ...point, roomId: room.id })),
    roomList: [],
    summary,
    whole: { ...summary, points },
  };
}

export function levelRemoval(
  level: { addedAt: string | null; id: string; name: string },
  rooms: RemovedRoom[],
  contributors: RemovedContributor[],
): InspectionRemoval {
  const points = rooms.flatMap((room) => room.points);
  const summary = {
    attachmentCount: photoCount(points),
    levelAddedAt: level.addedAt,
    levelId: level.id,
    levelName: level.name,
    pointCount: points.length,
    roomCount: rooms.length,
  };
  return {
    action: "inspection.level_removed",
    context: { levelId: level.id, levelName: level.name },
    contributors,
    pointTextInSummary: false,
    points: rooms.flatMap((room) => room.points.map((point) => ({ ...point, roomId: room.id }))),
    roomList: rooms.map((room) => ({
      ...stamp(room),
      attachmentCount: photoCount(room.points),
      description: room.description,
      id: room.id,
      name: room.name,
      pointCount: room.points.length,
    })),
    summary,
    whole: { ...summary, contributors, rooms },
  };
}

/** Fills rows up to the budget, in order. `base` is what an empty row already costs. */
class RowFiller<T> {
  private readonly rows: T[][] = [];
  private current: T[] = [];
  private used: number;

  constructor(private readonly base: number) {
    this.used = base;
  }

  add(item: T, bytes: number): void {
    const comma = this.current.length > 0 ? 1 : 0;
    if (comma === 1 && this.used + comma + bytes > REMOVAL_ROW_BUDGET_BYTES) {
      this.rows.push(this.current);
      this.current = [];
      this.used = this.base;
    }
    this.used += (this.current.length > 0 ? 1 : 0) + bytes;
    this.current.push(item);
  }

  finish(): T[][] {
    return this.current.length > 0 ? [...this.rows, this.current] : this.rows;
  }
}

const withCounts = (fields: Json, extra: Json = {}): Json => ({
  ...fields,
  ...extra,
  part: WIDEST_COUNT,
  parts: WIDEST_COUNT,
});

/** One point into the rows being filled. A point too big for an empty row goes
 *  in slices of its photo records, each slice naming the point. */
function addPoint(filler: RowFiller<SplitPoint>, emptyRow: number, point: RemovedPoint & { roomId: string }, withText: boolean): void {
  const text = withText ? { ...stamp(point), description: point.description } : {};
  const whole: SplitPoint = { attachments: point.attachments, id: point.id, roomId: point.roomId, ...text };
  const wholeBytes = snapshotBytes(whole);
  if (emptyRow + wholeBytes <= REMOVAL_ROW_BUDGET_BYTES) {
    filler.add(whole, wholeBytes);
    return;
  }
  let next = 0;
  let first = true;
  while (first || next < point.attachments.length) {
    const frame: SplitPoint = { attachments: [], id: point.id, roomId: point.roomId, ...(first ? text : { continued: true }) };
    const frameBytes = snapshotBytes(frame);
    const slice: RemovedPhoto[] = [];
    let sliceBytes = 0;
    while (next < point.attachments.length) {
      const photo = point.attachments[next];
      const bytes = snapshotBytes(photo) + (slice.length > 0 ? 1 : 0);
      if (slice.length > 0 && emptyRow + frameBytes + sliceBytes + bytes > REMOVAL_ROW_BUDGET_BYTES) break;
      slice.push(photo);
      sliceBytes += bytes;
      next += 1;
    }
    filler.add({ ...frame, attachments: slice }, frameBytes + sliceBytes);
    first = false;
  }
}

/** The `before` snapshots to record, in order. One when the removal fits. */
export function removalSnapshots(removal: InspectionRemoval): Json[] {
  if (snapshotBytes(removal.whole) <= REMOVAL_ROW_BUDGET_BYTES) return [removal.whole];

  const hasRooms = removal.roomList.length > 0;
  const summaryRow = withCounts(removal.summary, hasRooms ? { rooms: [] } : {});
  const rooms = new RowFiller<Json>(snapshotBytes(summaryRow));
  for (const room of removal.roomList) rooms.add(room, snapshotBytes(room));
  const roomRows = rooms.finish();

  const pointEmptyRow = snapshotBytes(withCounts(removal.context, { points: [] }));
  const points = new RowFiller<SplitPoint>(pointEmptyRow);
  for (const point of removal.points) addPoint(points, pointEmptyRow, point, !removal.pointTextInSummary);
  const pointRows = points.finish();

  const contributorEmptyRow = snapshotBytes(withCounts(removal.context, { contributors: [] }));
  const contributors = new RowFiller<Json>(contributorEmptyRow);
  for (const contributor of removal.contributors) contributors.add(contributor, snapshotBytes(contributor));
  const contributorRows = contributors.finish();

  const summaryAndRooms = Math.max(roomRows.length, 1);
  const parts = summaryAndRooms + contributorRows.length + pointRows.length;
  return [
    { ...removal.summary, part: 1, parts, ...(hasRooms ? { rooms: roomRows[0] } : {}) },
    ...roomRows.slice(1).map((chunk, i) => ({ ...removal.context, part: i + 2, parts, rooms: chunk })),
    ...contributorRows.map((chunk, i) => ({ ...removal.context, contributors: chunk, part: summaryAndRooms + i + 1, parts })),
    ...pointRows.map((chunk, i) => ({
      ...removal.context,
      part: summaryAndRooms + contributorRows.length + i + 1,
      parts,
      points: chunk,
    })),
  ];
}

/**
 * Records a removal in the caller's open transaction. Every row is checked
 * against the ledger's own validation before the first is written; a row that
 * is refused or fails to write throws, and the caller rolls the op back.
 */
export async function recordInspectionRemoval(
  tx: LedgerTx,
  args: { actor: LedgerActor; buildingId: number | null; inspectionId: number; removal: InspectionRemoval },
): Promise<void> {
  const snapshots = removalSnapshots(args.removal);
  const correlationId = snapshots.length > 1 ? newCorrelationId() : undefined;
  const entries: LedgerEntryInput[] = snapshots.map((before) => ({
    action: args.removal.action,
    actor: args.actor,
    before,
    buildingId: args.buildingId,
    ...(correlationId ? { correlationId } : {}),
    subject: { id: args.inspectionId, type: "inspection" },
  }));
  for (const entry of entries) assertLedgerEntry(entry);
  for (const entry of entries) await record(tx, entry);
}
