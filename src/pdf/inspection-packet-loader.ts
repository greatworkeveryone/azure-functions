// Loads everything buildInspectionPacket needs: the inspection header, its
// nested levels/rooms/points, raised-job ids, and each photo's blob bytes.
// Own SQL (mirrors loadInspection in functions/inspections.ts) so the pdf/
// module stays self-contained — no import cycle with the handler that lives
// in functions/inspections.ts.

import { Connection, TYPES } from "tedious";
import { executeQuery } from "../db";
import { downloadBlob } from "../blob-storage";
import type { InspectionPacketInput, PacketLevel, PacketPhoto } from "./inspection-packet";

export async function loadInspectionPacketInputs(
  connection: Connection,
  id: number,
): Promise<InspectionPacketInput | null> {
  // Tedious is single-flight per connection — these loads MUST stay awaited
  // sequentially (each depends on the prior's ids); do NOT Promise.all them.
  const inspectionRows = await executeQuery(
    connection,
    `SELECT i.Id, b.BuildingName, i.Title, i.Status,
            i.CreatedAt, i.CreatedByName, i.CompletedAt, i.CompletedByName
       FROM dbo.Inspections i
       JOIN dbo.Buildings b ON b.BuildingID = i.BuildingId
      WHERE i.Id = @Id`,
    [{ name: "Id", type: TYPES.Int, value: id }],
  );
  if (inspectionRows.length === 0) return null;
  const i = inspectionRows[0];

  const levelRows = await executeQuery(
    connection,
    `SELECT Id, Name FROM dbo.InspectionLevels
      WHERE InspectionId = @Id ORDER BY SortOrder, AddedAt`,
    [{ name: "Id", type: TYPES.Int, value: id }],
  );
  const levelIds = levelRows.map((r) => r.Id as string);

  const roomRows = levelIds.length
    ? await executeQuery(
        connection,
        `SELECT Id, LevelId, Name FROM dbo.InspectionRooms
          WHERE LevelId IN (${levelIds.map((_, idx) => `@L${idx}`).join(",")})
          ORDER BY SortOrder, AddedAt`,
        levelIds.map((lid, idx) => ({ name: `L${idx}`, type: TYPES.NVarChar, value: lid })),
      )
    : [];
  const roomIds = roomRows.map((r) => r.Id as string);

  const pointRows = roomIds.length
    ? await executeQuery(
        connection,
        `SELECT Id, RoomId, Description, AddedByName, AddedAt FROM dbo.InspectionPoints
          WHERE RoomId IN (${roomIds.map((_, idx) => `@R${idx}`).join(",")})
          ORDER BY SortOrder, AddedAt`,
        roomIds.map((rid, idx) => ({ name: `R${idx}`, type: TYPES.NVarChar, value: rid })),
      )
    : [];
  // Match the read-only view (isBlankInspectionPoint / visibleInspectionLevels):
  // rooms seed with a blank placeholder point, hidden in the Summary modal — drop
  // points with an empty/whitespace description so the PDF's contents AND totals
  // agree with the modal the download launches from.
  const keptPointRows = pointRows.filter(
    (r) => ((r.Description as string | null) ?? "").trim().length > 0,
  );
  const pointIds = keptPointRows.map((r) => r.Id as string);

  const attachmentRows = pointIds.length
    ? await executeQuery(
        connection,
        `SELECT PointId, BlobName, FileName FROM dbo.InspectionAttachments
          WHERE PointId IN (${pointIds.map((_, idx) => `@P${idx}`).join(",")})
          ORDER BY UploadedAt`,
        pointIds.map((pid, idx) => ({ name: `P${idx}`, type: TYPES.NVarChar, value: pid })),
      )
    : [];

  const raisedRows = pointIds.length
    ? await executeQuery(
        connection,
        `SELECT PointId, JobId FROM dbo.InspectionRaisedJobs
          WHERE InspectionId = @Id ORDER BY RaisedAt`,
        [{ name: "Id", type: TYPES.Int, value: id }],
      )
    : [];

  // Download every photo blob up front (best-effort — blob storage is not
  // single-flight like a tedious connection, but cap concurrency so a large
  // inspection doesn't open hundreds of simultaneous Storage connections.
  const bytesByBlob = await downloadInBatches(attachmentRows.map((a) => a.BlobName as string));

  const roomsByLevel = groupBy(roomRows, (r) => r.LevelId as string);
  const pointsByRoom = groupBy(keptPointRows, (r) => r.RoomId as string);
  const attachmentsByPoint = groupBy(attachmentRows, (r) => r.PointId as string);
  const jobsByPoint = groupBy(raisedRows, (r) => r.PointId as string);

  // Mirror visibleInspectionLevels: keep only non-blank points, drop rooms left
  // with none, then drop levels left with no rooms.
  const levels: PacketLevel[] = levelRows
    .map((lvl) => {
      const lid = lvl.Id as string;
      const rooms = (roomsByLevel.get(lid) ?? [])
        .map((room) => {
          const rid = room.Id as string;
          const points = (pointsByRoom.get(rid) ?? []).map((point) => {
            const pid = point.Id as string;
            const raisedJobIds = (jobsByPoint.get(pid) ?? []).map((r) => r.JobId as number);
            const photos: PacketPhoto[] = (attachmentsByPoint.get(pid) ?? [])
              .map((a) => {
                const bytes = bytesByBlob.get(a.BlobName as string);
                return bytes ? { fileName: (a.FileName as string) ?? "photo", bytes } : null;
              })
              .filter((p): p is PacketPhoto => p !== null);
            return {
              description: (point.Description as string | null) ?? "",
              addedByName: (point.AddedByName as string) ?? "",
              addedAt: point.AddedAt as Date,
              raisedJobIds,
              photos,
            };
          });
          return { name: room.Name as string, points };
        })
        .filter((room) => room.points.length > 0); // drop rooms with no surviving points
      return { name: lvl.Name as string, rooms };
    })
    .filter((lvl) => lvl.rooms.length > 0); // drop levels with no surviving rooms

  // Derive totals from the FILTERED tree so they can never disagree with what's
  // rendered (and with the Summary modal the download launches from).
  const totals = {
    levels: levels.length,
    rooms: levels.reduce((n, l) => n + l.rooms.length, 0),
    issues: levels.reduce((n, l) => n + l.rooms.reduce((m, r) => m + r.points.length, 0), 0),
    jobs: new Set(
      levels.flatMap((l) => l.rooms.flatMap((r) => r.points.flatMap((p) => p.raisedJobIds))),
    ).size,
  };

  return {
    id: i.Id as number,
    title: (i.Title as string | null) ?? `Inspection #${i.Id}`,
    buildingName: i.BuildingName as string,
    status: i.Status as string,
    createdByName: (i.CreatedByName as string) ?? "",
    createdAt: i.CreatedAt as Date,
    completedByName: (i.CompletedByName as string | null) ?? undefined,
    completedAt: (i.CompletedAt as Date | null) ?? undefined,
    totals,
    levels,
  };
}

const BLOB_DOWNLOAD_BATCH = 8;

async function downloadInBatches(blobNames: string[]): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (let i = 0; i < blobNames.length; i += BLOB_DOWNLOAD_BATCH) {
    const batch = blobNames.slice(i, i + BLOB_DOWNLOAD_BATCH);
    const bytes = await Promise.all(batch.map((bn) => maybeLoadBlob(bn)));
    batch.forEach((bn, idx) => {
      const b = bytes[idx];
      if (b) out.set(bn, b);
    });
  }
  return out;
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = map.get(k);
    if (bucket) bucket.push(row);
    else map.set(k, [row]);
  }
  return map;
}

async function maybeLoadBlob(blobName: string | null): Promise<Buffer | null> {
  if (!blobName) return null;
  try {
    return await downloadBlob(blobName);
  } catch {
    return null; // best-effort — a missing blob never fails the packet
  }
}
