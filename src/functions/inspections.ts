// Inspections — building walkthroughs with offline-first edits.
// Sub-resources (levels, rooms, points, attachments) use client-generated UUIDs
// so a tablet can mutate them while offline and replay the ops via
// /applyInspectionOps when it reconnects. Each op carries its own UUID for
// idempotent replay.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import {
  closeConnection,
  createConnection,
  executeQuery,
  beginTransaction,
  commitTransaction,
  rollbackTransaction,
  SqlRow,
} from "../db";
import {
  errorResponse,
  extractToken,
  oidFromToken,
  unauthorizedResponse,
} from "../auth";
import { deleteBlob, generateReadSasUrl, uploadBlob } from "../blob-storage";

// ── Caller identity ──────────────────────────────────────────────────────────

interface UserRef { id: string; name: string }

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function callerFromToken(token: string): UserRef {
  const claims = decodeJwtPayload(token);
  const id = oidFromToken(token) ?? (claims?.preferred_username as string) ?? "unknown";
  const name =
    (claims?.name as string) ?? (claims?.preferred_username as string) ?? "Unknown user";
  return { id, name };
}

// ── Row → API shape ──────────────────────────────────────────────────────────

interface InspectionApiPoint {
  addedAt: string;
  addedBy: UserRef;
  attachments: InspectionApiAttachment[];
  description: string;
  id: string;
  lastModified: string;
  raisedJobIds?: number[];
}

interface InspectionApiAttachment {
  blobName: string;
  fileName: string;
  id: string;
  uploadedAt: string;
  uploadedBy: UserRef;
  url: string;
}

interface InspectionApiRoom {
  addedAt: string;
  addedBy: UserRef;
  description?: string;
  id: string;
  name: string;
  points: InspectionApiPoint[];
}

interface InspectionApiLevel {
  addedAt: string;
  addedBy: UserRef[];
  id: string;
  name: string;
  rooms: InspectionApiRoom[];
}

interface InspectionApi {
  buildingId: number;
  buildingName: string;
  completedAt?: string;
  completedBy?: UserRef;
  createdAt: string;
  createdBy: UserRef;
  id: number;
  lastModified: string;
  levels: InspectionApiLevel[];
  mergedFromIds?: number[];
  mergedIntoId?: number;
  revision: number;
  status: "complete" | "draft" | "merged";
  title?: string;
}

const ATTACHMENT_SAS_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

// Builds a fully nested Inspection from a single ID using 5 batched queries.
// Stays cheap because each query is a single index lookup keyed on InspectionId.
async function loadInspection(connection: any, id: number): Promise<InspectionApi | null> {
  const inspectionRows = await executeQuery(
    connection,
    `SELECT i.Id, i.BuildingId, b.BuildingName, i.Title, i.Status, i.Revision,
            i.CreatedAt, i.CreatedById, i.CreatedByName,
            i.LastModifiedAt, i.CompletedAt, i.CompletedById, i.CompletedByName,
            i.MergedIntoId
     FROM dbo.Inspections i
     JOIN dbo.Buildings b ON b.BuildingID = i.BuildingId
     WHERE i.Id = @Id`,
    [{ name: "Id", type: TYPES.Int, value: id }],
  );
  if (inspectionRows.length === 0) return null;
  const i = inspectionRows[0];

  const levelRows = await executeQuery(
    connection,
    `SELECT Id, Name, AddedAt, SortOrder
     FROM dbo.InspectionLevels WHERE InspectionId = @Id
     ORDER BY SortOrder, AddedAt`,
    [{ name: "Id", type: TYPES.Int, value: id }],
  );
  const levelIds = levelRows.map((r) => r.Id as string);

  const contributorRows = levelIds.length
    ? await executeQuery(
        connection,
        `SELECT LevelId, UserId, UserName FROM dbo.InspectionLevelContributors
         WHERE LevelId IN (${levelIds.map((_, idx) => `@L${idx}`).join(",")})`,
        levelIds.map((lid, idx) => ({ name: `L${idx}`, type: TYPES.NVarChar, value: lid })),
      )
    : [];

  const roomRows = levelIds.length
    ? await executeQuery(
        connection,
        `SELECT Id, LevelId, Name, Description, AddedAt, AddedById, AddedByName, SortOrder
         FROM dbo.InspectionRooms
         WHERE LevelId IN (${levelIds.map((_, idx) => `@L${idx}`).join(",")})
         ORDER BY SortOrder, AddedAt`,
        levelIds.map((lid, idx) => ({ name: `L${idx}`, type: TYPES.NVarChar, value: lid })),
      )
    : [];
  const roomIds = roomRows.map((r) => r.Id as string);

  const pointRows = roomIds.length
    ? await executeQuery(
        connection,
        `SELECT Id, RoomId, Description, AddedAt, AddedById, AddedByName, LastModifiedAt, SortOrder
         FROM dbo.InspectionPoints
         WHERE RoomId IN (${roomIds.map((_, idx) => `@R${idx}`).join(",")})
         ORDER BY SortOrder, AddedAt`,
        roomIds.map((rid, idx) => ({ name: `R${idx}`, type: TYPES.NVarChar, value: rid })),
      )
    : [];
  const pointIds = pointRows.map((r) => r.Id as string);

  const attachmentRows = pointIds.length
    ? await executeQuery(
        connection,
        `SELECT Id, PointId, BlobName, FileName, UploadedAt, UploadedById, UploadedByName
         FROM dbo.InspectionAttachments
         WHERE PointId IN (${pointIds.map((_, idx) => `@P${idx}`).join(",")})
         ORDER BY UploadedAt`,
        pointIds.map((pid, idx) => ({ name: `P${idx}`, type: TYPES.NVarChar, value: pid })),
      )
    : [];

  const raisedRows = pointIds.length
    ? await executeQuery(
        connection,
        `SELECT PointId, JobId FROM dbo.InspectionRaisedJobs
         WHERE InspectionId = @Id
         ORDER BY RaisedAt`,
        [{ name: "Id", type: TYPES.Int, value: id }],
      )
    : [];

  const mergeSourceRows = await executeQuery(
    connection,
    `SELECT SourceInspectionId FROM dbo.InspectionMergeSources WHERE MergedInspectionId = @Id`,
    [{ name: "Id", type: TYPES.Int, value: id }],
  );

  // Group children by parent
  const contributorsByLevel = groupBy(contributorRows, (r) => r.LevelId as string);
  const roomsByLevel = groupBy(roomRows, (r) => r.LevelId as string);
  const pointsByRoom = groupBy(pointRows, (r) => r.RoomId as string);
  const attachmentsByPoint = groupBy(attachmentRows, (r) => r.PointId as string);
  const jobsByPoint = groupBy(raisedRows, (r) => r.PointId as string);

  const levels: InspectionApiLevel[] = levelRows.map((lvl) => {
    const lid = lvl.Id as string;
    return {
      addedAt: toIso(lvl.AddedAt),
      addedBy: (contributorsByLevel.get(lid) ?? []).map((c) => ({
        id: c.UserId as string,
        name: c.UserName as string,
      })),
      id: lid,
      name: lvl.Name as string,
      rooms: (roomsByLevel.get(lid) ?? []).map((room) => {
        const rid = room.Id as string;
        return {
          addedAt: toIso(room.AddedAt),
          addedBy: { id: room.AddedById as string, name: room.AddedByName as string },
          description: (room.Description as string | null) ?? undefined,
          id: rid,
          name: room.Name as string,
          points: (pointsByRoom.get(rid) ?? []).map((point) => {
            const pid = point.Id as string;
            const raisedJobIds = (jobsByPoint.get(pid) ?? []).map((r) => r.JobId as number);
            const attachments: InspectionApiAttachment[] = (
              attachmentsByPoint.get(pid) ?? []
            ).map((a) => ({
              blobName: a.BlobName as string,
              fileName: a.FileName as string,
              id: a.Id as string,
              uploadedAt: toIso(a.UploadedAt),
              uploadedBy: { id: a.UploadedById as string, name: a.UploadedByName as string },
              url: generateReadSasUrl(a.BlobName as string, ATTACHMENT_SAS_TTL_MS),
            }));
            return {
              addedAt: toIso(point.AddedAt),
              addedBy: { id: point.AddedById as string, name: point.AddedByName as string },
              attachments,
              description: (point.Description as string | null) ?? "",
              id: pid,
              lastModified: toIso(point.LastModifiedAt),
              raisedJobIds: raisedJobIds.length > 0 ? raisedJobIds : undefined,
            };
          }),
        };
      }),
    };
  });

  const out: InspectionApi = {
    buildingId: i.BuildingId as number,
    buildingName: i.BuildingName as string,
    createdAt: toIso(i.CreatedAt),
    createdBy: { id: i.CreatedById as string, name: i.CreatedByName as string },
    id: i.Id as number,
    lastModified: toIso(i.LastModifiedAt),
    levels,
    revision: i.Revision as number,
    status: i.Status as "complete" | "draft" | "merged",
    title: (i.Title as string | null) ?? undefined,
  };
  if (i.CompletedAt) {
    out.completedAt = toIso(i.CompletedAt);
    out.completedBy = {
      id: (i.CompletedById as string) ?? "",
      name: (i.CompletedByName as string) ?? "",
    };
  }
  if (i.MergedIntoId) out.mergedIntoId = i.MergedIntoId as number;
  if (mergeSourceRows.length > 0) {
    out.mergedFromIds = mergeSourceRows.map((r) => r.SourceInspectionId as number);
  }
  return out;
}

function groupBy<T>(rows: T[], keyFn: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const r of rows) {
    const k = keyFn(r);
    const existing = map.get(k);
    if (existing) existing.push(r);
    else map.set(k, [r]);
  }
  return map;
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date().toISOString();
}

async function bumpRevision(connection: any, inspectionId: number): Promise<number> {
  const rows = await executeQuery(
    connection,
    `UPDATE dbo.Inspections
     SET LastModifiedAt = SYSUTCDATETIME(), Revision = Revision + 1
     OUTPUT INSERTED.Revision
     WHERE Id = @Id`,
    [{ name: "Id", type: TYPES.Int, value: inspectionId }],
  );
  return rows[0]?.Revision as number;
}

// ── GET /api/getInspections ──────────────────────────────────────────────────

async function getInspections(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    connection = await createConnection(token);

    const inspectionRows = await executeQuery(
      connection,
      `SELECT i.Id, i.BuildingId, b.BuildingName, i.Title, i.Status, i.Revision,
              i.CreatedAt, i.CreatedById, i.CreatedByName,
              i.LastModifiedAt, i.CompletedAt, i.CompletedById, i.CompletedByName,
              i.MergedIntoId
       FROM dbo.Inspections i
       JOIN dbo.Buildings b ON b.BuildingID = i.BuildingId
       ORDER BY i.LastModifiedAt DESC`,
      [],
    );

    const inspectionIds = inspectionRows.map((r) => r.Id as number);

    // Pull just the structural counts for the list view — no attachments or
    // contributors needed; the row only shows level/room/point totals.
    const levelRows = inspectionIds.length
      ? await executeQuery(
          connection,
          `SELECT InspectionId, COUNT(*) AS C
           FROM dbo.InspectionLevels WHERE InspectionId IN (${inspectionIds.map((_, idx) => `@I${idx}`).join(",")})
           GROUP BY InspectionId`,
          inspectionIds.map((id, idx) => ({ name: `I${idx}`, type: TYPES.Int, value: id })),
        )
      : [];
    const levelCountByInspection = new Map(levelRows.map((r) => [r.InspectionId as number, r.C as number]));

    // Build minimal-but-correct shape for list rows. Detail page calls
    // /getInspection for the full nested structure.
    const inspections: InspectionApi[] = inspectionRows.map((i) => {
      const out: InspectionApi = {
        buildingId: i.BuildingId as number,
        buildingName: i.BuildingName as string,
        createdAt: toIso(i.CreatedAt),
        createdBy: { id: i.CreatedById as string, name: i.CreatedByName as string },
        id: i.Id as number,
        lastModified: toIso(i.LastModifiedAt),
        // Synthesise level placeholders so the row's count math still works.
        // Frontend only counts levels.length for the row badge.
        levels: Array.from({ length: levelCountByInspection.get(i.Id as number) ?? 0 }, (_, idx) => ({
          addedAt: toIso(i.CreatedAt),
          addedBy: [],
          id: `placeholder-${i.Id}-${idx}`,
          name: "",
          rooms: [],
        })),
        revision: i.Revision as number,
        status: i.Status as "complete" | "draft" | "merged",
        title: (i.Title as string | null) ?? undefined,
      };
      if (i.CompletedAt) {
        out.completedAt = toIso(i.CompletedAt);
        out.completedBy = {
          id: (i.CompletedById as string) ?? "",
          name: (i.CompletedByName as string) ?? "",
        };
      }
      if (i.MergedIntoId) out.mergedIntoId = i.MergedIntoId as number;
      return out;
    });

    return { status: 200, jsonBody: { count: inspections.length, inspections } };
  } catch (error: any) {
    context.error("getInspections failed:", error.message);
    return errorResponse("Failed to fetch inspections", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── GET /api/getInspection?id=N ──────────────────────────────────────────────

async function getInspection(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const id = Number(request.query.get("id"));
  if (!id) return { status: 400, jsonBody: { error: "id query param required" } };

  let connection;
  try {
    connection = await createConnection(token);
    const inspection = await loadInspection(connection, id);
    if (!inspection) return { status: 404, jsonBody: { error: "Inspection not found" } };
    return { status: 200, jsonBody: { inspection } };
  } catch (error: any) {
    context.error("getInspection failed:", error.message);
    return errorResponse("Failed to fetch inspection", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/createInspection ───────────────────────────────────────────────

async function createInspection(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const { BuildingId, Title } = body ?? {};
    if (!BuildingId) {
      return { status: 400, jsonBody: { error: "BuildingId required" } };
    }
    const caller = callerFromToken(token);

    connection = await createConnection(token);
    const inserted = await executeQuery(
      connection,
      `INSERT INTO dbo.Inspections (BuildingId, Title, CreatedById, CreatedByName)
       OUTPUT INSERTED.Id
       VALUES (@BuildingId, @Title, @CreatedById, @CreatedByName)`,
      [
        { name: "BuildingId",    type: TYPES.Int,       value: BuildingId },
        { name: "Title",         type: TYPES.NVarChar,  value: Title ?? null },
        { name: "CreatedById",   type: TYPES.NVarChar,  value: caller.id },
        { name: "CreatedByName", type: TYPES.NVarChar,  value: caller.name },
      ],
    );
    const newId = inserted[0].Id as number;
    const inspection = await loadInspection(connection, newId);
    return { status: 200, jsonBody: { inspection } };
  } catch (error: any) {
    context.error("createInspection failed:", error.message);
    return errorResponse("Failed to create inspection", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/applyInspectionOps ─────────────────────────────────────────────
// Body: { inspectionId, baseRevision?, ops: QueuedOp[] }
// Applies a batch transactionally. Each op carries a UUID; replays are no-ops.

interface ClientOp {
  createdAt: string;
  id: string;
  inspectionId: number;
  op: any;
}

async function applyInspectionOps(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const inspectionId: number | undefined = body?.inspectionId;
    const baseRevision: number | undefined = body?.baseRevision;
    const ops: ClientOp[] = Array.isArray(body?.ops) ? body.ops : [];

    if (!inspectionId) {
      return { status: 400, jsonBody: { error: "inspectionId required" } };
    }
    if (ops.length === 0) {
      return { status: 400, jsonBody: { error: "ops array must be non-empty" } };
    }

    connection = await createConnection(token);

    // Optional concurrency guard
    if (typeof baseRevision === "number") {
      const rev = await executeQuery(
        connection,
        `SELECT Revision FROM dbo.Inspections WHERE Id = @Id`,
        [{ name: "Id", type: TYPES.Int, value: inspectionId }],
      );
      if (rev.length === 0) return { status: 404, jsonBody: { error: "Inspection not found" } };
      const current = rev[0].Revision as number;
      if (current !== baseRevision) {
        const fresh = await loadInspection(connection, inspectionId);
        return { status: 409, jsonBody: { current: current, error: "revision-mismatch", inspection: fresh } };
      }
    }

    await beginTransaction(connection);
    const applied: string[] = [];
    const rejected: { id: string; reason: string }[] = [];

    try {
      for (const queued of ops) {
        if (!queued.id) {
          rejected.push({ id: queued.id ?? "(missing)", reason: "op missing id" });
          continue;
        }

        const seen = await executeQuery(
          connection,
          `SELECT 1 AS X FROM dbo.InspectionOperationLog WHERE OpId = @OpId`,
          [{ name: "OpId", type: TYPES.NVarChar, value: queued.id }],
        );
        if (seen.length > 0) {
          // Already applied — idempotent no-op
          applied.push(queued.id);
          continue;
        }

        try {
          await applyOne(connection, inspectionId, queued.op);
          await executeQuery(
            connection,
            `INSERT INTO dbo.InspectionOperationLog (OpId, InspectionId, OpType)
             VALUES (@OpId, @InspectionId, @OpType)`,
            [
              { name: "OpId",         type: TYPES.NVarChar, value: queued.id },
              { name: "InspectionId", type: TYPES.Int,      value: inspectionId },
              { name: "OpType",       type: TYPES.NVarChar, value: String(queued.op?.type ?? "unknown") },
            ],
          );
          applied.push(queued.id);
        } catch (err: any) {
          context.warn(`op ${queued.id} (${queued.op?.type}) failed: ${err.message}`);
          rejected.push({ id: queued.id, reason: err.message });
        }
      }

      const revision = await bumpRevision(connection, inspectionId);
      await commitTransaction(connection);
      return { status: 200, jsonBody: { applied, rejected: rejected.length > 0 ? rejected : undefined, revision } };
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }
  } catch (error: any) {
    context.error("applyInspectionOps failed:", error.message);
    return errorResponse("Failed to apply ops", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

async function applyOne(connection: any, inspectionId: number, op: any): Promise<void> {
  switch (op?.type) {
    case "addLevel": {
      await executeQuery(
        connection,
        `INSERT INTO dbo.InspectionLevels (Id, InspectionId, Name, AddedAt)
         VALUES (@Id, @InspectionId, @Name, @AddedAt)`,
        [
          { name: "Id",           type: TYPES.NVarChar, value: op.levelId },
          { name: "InspectionId", type: TYPES.Int,      value: inspectionId },
          { name: "Name",         type: TYPES.NVarChar, value: op.name },
          { name: "AddedAt",      type: TYPES.NVarChar, value: op.addedAt },
        ],
      );
      await executeQuery(
        connection,
        `INSERT INTO dbo.InspectionLevelContributors (LevelId, UserId, UserName)
         VALUES (@LevelId, @UserId, @UserName)`,
        [
          { name: "LevelId",  type: TYPES.NVarChar, value: op.levelId },
          { name: "UserId",   type: TYPES.NVarChar, value: op.addedBy?.id ?? "unknown" },
          { name: "UserName", type: TYPES.NVarChar, value: op.addedBy?.name ?? "Unknown" },
        ],
      );
      return;
    }
    case "removeLevel": {
      // ON DELETE CASCADE handles rooms → points → attachments + contributors.
      await executeQuery(
        connection,
        `DELETE FROM dbo.InspectionLevels WHERE Id = @Id AND InspectionId = @InspectionId`,
        [
          { name: "Id",           type: TYPES.NVarChar, value: op.levelId },
          { name: "InspectionId", type: TYPES.Int,      value: inspectionId },
        ],
      );
      return;
    }
    case "addRoom": {
      await executeQuery(
        connection,
        `INSERT INTO dbo.InspectionRooms (Id, LevelId, Name, Description, AddedAt, AddedById, AddedByName)
         VALUES (@Id, @LevelId, @Name, @Description, @AddedAt, @AddedById, @AddedByName)`,
        [
          { name: "Id",          type: TYPES.NVarChar, value: op.roomId },
          { name: "LevelId",     type: TYPES.NVarChar, value: op.levelId },
          { name: "Name",        type: TYPES.NVarChar, value: op.name },
          { name: "Description", type: TYPES.NVarChar, value: op.description ?? null },
          { name: "AddedAt",     type: TYPES.NVarChar, value: op.addedAt },
          { name: "AddedById",   type: TYPES.NVarChar, value: op.addedBy?.id ?? "unknown" },
          { name: "AddedByName", type: TYPES.NVarChar, value: op.addedBy?.name ?? "Unknown" },
        ],
      );
      return;
    }
    case "updateRoom": {
      const fields: string[] = [];
      const params: any[] = [{ name: "RoomId", type: TYPES.NVarChar, value: op.roomId }];
      if (op.patch?.name !== undefined) {
        fields.push("Name = @Name");
        params.push({ name: "Name", type: TYPES.NVarChar, value: op.patch.name });
      }
      if (op.patch?.description !== undefined) {
        fields.push("Description = @Description");
        params.push({ name: "Description", type: TYPES.NVarChar, value: op.patch.description ?? null });
      }
      if (fields.length === 0) return;
      await executeQuery(
        connection,
        `UPDATE dbo.InspectionRooms SET ${fields.join(", ")} WHERE Id = @RoomId`,
        params,
      );
      return;
    }
    case "removeRoom": {
      await executeQuery(
        connection,
        `DELETE FROM dbo.InspectionRooms WHERE Id = @Id`,
        [{ name: "Id", type: TYPES.NVarChar, value: op.roomId }],
      );
      return;
    }
    case "addPoint": {
      await executeQuery(
        connection,
        `INSERT INTO dbo.InspectionPoints (Id, RoomId, Description, AddedAt, AddedById, AddedByName, LastModifiedAt)
         VALUES (@Id, @RoomId, @Description, @AddedAt, @AddedById, @AddedByName, @AddedAt)`,
        [
          { name: "Id",          type: TYPES.NVarChar, value: op.pointId },
          { name: "RoomId",      type: TYPES.NVarChar, value: op.roomId },
          { name: "Description", type: TYPES.NVarChar, value: op.description ?? "" },
          { name: "AddedAt",     type: TYPES.NVarChar, value: op.addedAt },
          { name: "AddedById",   type: TYPES.NVarChar, value: op.addedBy?.id ?? "unknown" },
          { name: "AddedByName", type: TYPES.NVarChar, value: op.addedBy?.name ?? "Unknown" },
        ],
      );
      return;
    }
    case "updatePoint": {
      if (op.patch?.description === undefined) return;
      await executeQuery(
        connection,
        `UPDATE dbo.InspectionPoints
         SET Description = @Description, LastModifiedAt = SYSUTCDATETIME()
         WHERE Id = @Id`,
        [
          { name: "Id",          type: TYPES.NVarChar, value: op.pointId },
          { name: "Description", type: TYPES.NVarChar, value: op.patch.description },
        ],
      );
      return;
    }
    case "removePoint": {
      await executeQuery(
        connection,
        `DELETE FROM dbo.InspectionPoints WHERE Id = @Id`,
        [{ name: "Id", type: TYPES.NVarChar, value: op.pointId }],
      );
      return;
    }
    case "addAttachment": {
      await executeQuery(
        connection,
        `INSERT INTO dbo.InspectionAttachments
           (Id, PointId, BlobName, FileName, UploadedAt, UploadedById, UploadedByName)
         VALUES
           (@Id, @PointId, @BlobName, @FileName, @UploadedAt, @UploadedById, @UploadedByName)`,
        [
          { name: "Id",             type: TYPES.NVarChar, value: op.attachmentId },
          { name: "PointId",        type: TYPES.NVarChar, value: op.pointId },
          { name: "BlobName",       type: TYPES.NVarChar, value: op.blobName },
          { name: "FileName",       type: TYPES.NVarChar, value: op.fileName },
          { name: "UploadedAt",     type: TYPES.NVarChar, value: op.uploadedAt },
          { name: "UploadedById",   type: TYPES.NVarChar, value: op.uploadedBy?.id ?? "unknown" },
          { name: "UploadedByName", type: TYPES.NVarChar, value: op.uploadedBy?.name ?? "Unknown" },
        ],
      );
      return;
    }
    case "removeAttachment": {
      const rows = await executeQuery(
        connection,
        `SELECT BlobName FROM dbo.InspectionAttachments WHERE Id = @Id`,
        [{ name: "Id", type: TYPES.NVarChar, value: op.attachmentId }],
      );
      const blobName = rows[0]?.BlobName as string | undefined;
      await executeQuery(
        connection,
        `DELETE FROM dbo.InspectionAttachments WHERE Id = @Id`,
        [{ name: "Id", type: TYPES.NVarChar, value: op.attachmentId }],
      );
      if (blobName) {
        try { await deleteBlob(blobName); } catch { /* best effort — orphan blob isn't fatal */ }
      }
      return;
    }
    case "complete":
    case "revert":
      // Status transitions are handled by their dedicated endpoints; ignore
      // here so a stale queued op can't change status from the wrong path.
      return;
    default:
      throw new Error(`Unknown op type: ${op?.type}`);
  }
}

// ── POST /api/completeInspection ─────────────────────────────────────────────

async function completeInspection(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const inspectionId: number | undefined = body?.InspectionId ?? body?.inspectionId;
    if (!inspectionId) return { status: 400, jsonBody: { error: "InspectionId required" } };
    const caller = callerFromToken(token);

    connection = await createConnection(token);
    await executeQuery(
      connection,
      `UPDATE dbo.Inspections
       SET Status = 'complete',
           CompletedAt = SYSUTCDATETIME(),
           CompletedById = @CompletedById,
           CompletedByName = @CompletedByName,
           LastModifiedAt = SYSUTCDATETIME(),
           Revision = Revision + 1
       WHERE Id = @Id AND Status = 'draft'`,
      [
        { name: "Id",              type: TYPES.Int,      value: inspectionId },
        { name: "CompletedById",   type: TYPES.NVarChar, value: caller.id },
        { name: "CompletedByName", type: TYPES.NVarChar, value: caller.name },
      ],
    );
    const inspection = await loadInspection(connection, inspectionId);
    return { status: 200, jsonBody: { inspection } };
  } catch (error: any) {
    context.error("completeInspection failed:", error.message);
    return errorResponse("Failed to complete inspection", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/revertInspection ───────────────────────────────────────────────

async function revertInspection(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const inspectionId: number | undefined = body?.InspectionId ?? body?.inspectionId;
    if (!inspectionId) return { status: 400, jsonBody: { error: "InspectionId required" } };

    connection = await createConnection(token);
    await executeQuery(
      connection,
      `UPDATE dbo.Inspections
       SET Status = 'draft',
           CompletedAt = NULL,
           CompletedById = NULL,
           CompletedByName = NULL,
           LastModifiedAt = SYSUTCDATETIME(),
           Revision = Revision + 1
       WHERE Id = @Id AND Status = 'complete'`,
      [{ name: "Id", type: TYPES.Int, value: inspectionId }],
    );
    const inspection = await loadInspection(connection, inspectionId);
    return { status: 200, jsonBody: { inspection } };
  } catch (error: any) {
    context.error("revertInspection failed:", error.message);
    return errorResponse("Failed to revert inspection", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/uploadInspectionAttachment ─────────────────────────────────────
// Multipart form: 'file' = the blob to upload. Returns { blobName } so the
// caller can enqueue an addAttachment op via /applyInspectionOps.

async function uploadInspectionAttachment(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    if (!file) return { status: 400, jsonBody: { error: "'file' field required" } };

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await uploadBlob(buffer, file.name, file.type || "image/jpeg", "inspections");
    return {
      status: 200,
      jsonBody: {
        blobName: result.blobName,
        url: generateReadSasUrl(result.blobName, ATTACHMENT_SAS_TTL_MS),
      },
    };
  } catch (error: any) {
    context.error("uploadInspectionAttachment failed:", error.message);
    return errorResponse("Failed to upload attachment", error.message);
  }
}

// ── POST /api/mergeInspections ───────────────────────────────────────────────
// Body: { SourceIds: number[], Title?: string }

async function mergeInspections(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const sourceIds: number[] = Array.isArray(body?.SourceIds) ? body.SourceIds : [];
    const title: string | undefined = body?.Title;
    if (sourceIds.length < 2) {
      return { status: 400, jsonBody: { error: "SourceIds (at least 2) required" } };
    }
    const caller = callerFromToken(token);

    connection = await createConnection(token);

    // Validate sources: all draft, all same building
    const placeholders = sourceIds.map((_, idx) => `@S${idx}`).join(",");
    const params = sourceIds.map((id, idx) => ({ name: `S${idx}`, type: TYPES.Int, value: id }));
    const sourceRows = await executeQuery(
      connection,
      // eslint-disable-next-line local/no-sql-interpolation -- placeholders is built locally as "@S0,@S1,..." with bound params
      `SELECT Id, BuildingId, Status FROM dbo.Inspections WHERE Id IN (${placeholders})`,
      params,
    );
    if (sourceRows.length !== sourceIds.length) {
      return { status: 404, jsonBody: { error: "One or more source inspections not found" } };
    }
    if (sourceRows.some((r) => r.Status !== "draft")) {
      return { status: 400, jsonBody: { error: "Only draft inspections can be merged" } };
    }
    const buildingIds = new Set(sourceRows.map((r) => r.BuildingId as number));
    if (buildingIds.size > 1) {
      return { status: 400, jsonBody: { error: "All sources must be in the same building" } };
    }
    const buildingId = sourceRows[0].BuildingId as number;

    await beginTransaction(connection);
    try {
      // Create the merged inspection
      const inserted = await executeQuery(
        connection,
        `INSERT INTO dbo.Inspections (BuildingId, Title, CreatedById, CreatedByName)
         OUTPUT INSERTED.Id
         VALUES (@BuildingId, @Title, @CreatedById, @CreatedByName)`,
        [
          { name: "BuildingId",    type: TYPES.Int,      value: buildingId },
          { name: "Title",         type: TYPES.NVarChar, value: title ?? null },
          { name: "CreatedById",   type: TYPES.NVarChar, value: caller.id },
          { name: "CreatedByName", type: TYPES.NVarChar, value: caller.name },
        ],
      );
      const newId = inserted[0].Id as number;

      // Pull source levels grouped by name → merge into the new inspection
      const sourceLevels = await executeQuery(
        connection,
        // eslint-disable-next-line local/no-sql-interpolation -- placeholders is built locally as "@S0,@S1,..." with bound params
        `SELECT l.Id, l.InspectionId, l.Name, l.AddedAt, l.SortOrder
         FROM dbo.InspectionLevels l
         WHERE l.InspectionId IN (${placeholders})
         ORDER BY l.AddedAt`,
        params,
      );

      // For each unique level name, create a new merged level. Re-parent the
      // rooms (UPDATE LevelId) of every source level with that name.
      const newLevelByName = new Map<string, string>();
      for (const lvl of sourceLevels) {
        const name = lvl.Name as string;
        let newLevelId = newLevelByName.get(name);
        if (!newLevelId) {
          newLevelId = `lvl-merge-${newId}-${newLevelByName.size}`;
          newLevelByName.set(name, newLevelId);
          await executeQuery(
            connection,
            `INSERT INTO dbo.InspectionLevels (Id, InspectionId, Name, AddedAt, SortOrder)
             VALUES (@Id, @InspectionId, @Name, @AddedAt, @SortOrder)`,
            [
              { name: "Id",           type: TYPES.NVarChar, value: newLevelId },
              { name: "InspectionId", type: TYPES.Int,      value: newId },
              { name: "Name",         type: TYPES.NVarChar, value: name },
              { name: "AddedAt",      type: TYPES.NVarChar, value: toIso(lvl.AddedAt) },
              { name: "SortOrder",    type: TYPES.Int,      value: newLevelByName.size },
            ],
          );
        }

        // Union contributors from the source level into the merged level.
        const contributors = await executeQuery(
          connection,
          `SELECT UserId, UserName FROM dbo.InspectionLevelContributors WHERE LevelId = @LevelId`,
          [{ name: "LevelId", type: TYPES.NVarChar, value: lvl.Id as string }],
        );
        for (const c of contributors) {
          await executeQuery(
            connection,
            `IF NOT EXISTS (SELECT 1 FROM dbo.InspectionLevelContributors WHERE LevelId = @LevelId AND UserId = @UserId)
             INSERT INTO dbo.InspectionLevelContributors (LevelId, UserId, UserName)
             VALUES (@LevelId, @UserId, @UserName)`,
            [
              { name: "LevelId",  type: TYPES.NVarChar, value: newLevelId },
              { name: "UserId",   type: TYPES.NVarChar, value: c.UserId as string },
              { name: "UserName", type: TYPES.NVarChar, value: c.UserName as string },
            ],
          );
        }

        // Re-parent rooms of this source level to the merged level.
        await executeQuery(
          connection,
          `UPDATE dbo.InspectionRooms SET LevelId = @NewLevelId WHERE LevelId = @OldLevelId`,
          [
            { name: "NewLevelId", type: TYPES.NVarChar, value: newLevelId },
            { name: "OldLevelId", type: TYPES.NVarChar, value: lvl.Id as string },
          ],
        );
      }

      // Mark each source as merged
      for (const sid of sourceIds) {
        await executeQuery(
          connection,
          `UPDATE dbo.Inspections
           SET Status = 'merged', MergedIntoId = @MergedIntoId, LastModifiedAt = SYSUTCDATETIME()
           WHERE Id = @Id`,
          [
            { name: "Id",           type: TYPES.Int, value: sid },
            { name: "MergedIntoId", type: TYPES.Int, value: newId },
          ],
        );
        await executeQuery(
          connection,
          `INSERT INTO dbo.InspectionMergeSources (MergedInspectionId, SourceInspectionId)
           VALUES (@MergedId, @SourceId)`,
          [
            { name: "MergedId", type: TYPES.Int, value: newId },
            { name: "SourceId", type: TYPES.Int, value: sid },
          ],
        );
      }

      // Drop the now-empty source levels (rooms have been re-parented).
      await executeQuery(
        connection,
        // eslint-disable-next-line local/no-sql-interpolation -- placeholders is built locally as "@S0,@S1,..." with bound params
        `DELETE FROM dbo.InspectionLevels WHERE InspectionId IN (${placeholders})`,
        params,
      );

      await commitTransaction(connection);
      const inspection = await loadInspection(connection, newId);
      return { status: 200, jsonBody: { inspection } };
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }
  } catch (error: any) {
    context.error("mergeInspections failed:", error.message);
    return errorResponse("Failed to merge inspections", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/raiseJobsFromInspection ────────────────────────────────────────
// Body: {
//   InspectionId, PointIds[],
//   Mode: "per-point" | "per-room",
//   Defaults: { JobType, Priority, AssigneeName?, DescriptionPrefix? }
// }
// per-point: one Jobs row per pointId.
// per-room:  selected pointIds are grouped by their containing room and one
//            Jobs row is created per room, with a combined description and
//            every contributing point linked to it via InspectionRaisedJobs.
//
// For each Job the endpoint also:
//   1. Inserts a `creation` JobEvents row (CreationSource = "inspection") so
//      the activity feed mirrors a manually-created job.
//   2. Copies every InspectionAttachment of every contributing point into
//      dbo.Attachments linked to the new JobID. The blob is shared — only the
//      catalogue row is duplicated.
//   3. Records each contributing point in dbo.InspectionRaisedJobs so the
//      inspection UI marks the point as "Job raised".
//
// All writes run in one transaction — partial raises don't get persisted.

interface RaiseJobsBody {
  Defaults?: {
    AssigneeName?: string;
    DescriptionPrefix?: string;
    JobType?: string;
    Priority?: string;
    SubType?: string;
  };
  InspectionId?: number;
  Mode?: "per-point" | "per-room";
  PointIds?: string[];
}

interface PointContext {
  description: string;
  levelName: string;
  pointId: string;
  roomId: string;
  roomName: string;
}

interface RaisedJobOutput {
  jobId: number;
  pointIds: string[];
}

async function raiseJobsFromInspection(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as RaiseJobsBody;
    const inspectionId = body?.InspectionId;
    const pointIds = Array.isArray(body?.PointIds) ? body.PointIds : [];
    const mode = body?.Mode === "per-room" ? "per-room" : "per-point";
    const defaults = body?.Defaults ?? {};

    if (!inspectionId || pointIds.length === 0) {
      return { status: 400, jsonBody: { error: "InspectionId and PointIds[] required" } };
    }
    if (!defaults.JobType || !defaults.Priority) {
      return { status: 400, jsonBody: { error: "Defaults.JobType and Defaults.Priority required" } };
    }

    const caller = callerFromToken(token);
    const descriptionPrefix = (defaults.DescriptionPrefix ?? "").trim();
    const assignee = (defaults.AssigneeName ?? "").trim() || caller.name;

    connection = await createConnection(token);

    // Hydrate inspection state from the DB — never trust the client for the
    // text/level/room fields that go onto a real Job.
    const inspection = await loadInspection(connection, inspectionId);
    if (!inspection) {
      return { status: 404, jsonBody: { error: "Inspection not found" } };
    }

    const pointIndex = buildPointIndex(inspection);
    const missing = pointIds.filter((id) => !pointIndex.has(id));
    if (missing.length > 0) {
      return {
        status: 400,
        jsonBody: { error: `Unknown pointId(s): ${missing.join(", ")}` },
      };
    }

    // Group selected points into one batch per Job-to-create.
    const groups: PointContext[][] = [];
    if (mode === "per-room") {
      const byRoom = new Map<string, PointContext[]>();
      for (const id of pointIds) {
        const ctx = pointIndex.get(id)!;
        const list = byRoom.get(ctx.roomId);
        if (list) list.push(ctx);
        else byRoom.set(ctx.roomId, [ctx]);
      }
      for (const list of byRoom.values()) groups.push(list);
    } else {
      for (const id of pointIds) groups.push([pointIndex.get(id)!]);
    }

    const raised: RaisedJobOutput[] = [];

    await beginTransaction(connection);
    try {
      for (const group of groups) {
        const first = group[0];
        const title = buildJobTitle(descriptionPrefix, first.levelName, first.roomName);
        const description = buildJobDescription(group);
        const isPerRoom = group.length > 1 || mode === "per-room";

        const inserted = await executeQuery(
          connection,
          `INSERT INTO dbo.Jobs (
             BuildingID, Title, Description, AssignedTo, Status, AwaitingRole,
             CreationMethod, CreatedBy,
             SourceInspectionId, SourceInspectionRoomId, SourceInspectionPointId,
             LevelName, ExactLocation, [Type], SubType, Priority
           )
           OUTPUT INSERTED.JobID
           VALUES (
             @BuildingID, @Title, @Description, @AssignedTo, 'New', 'facilities',
             'inspection', @CreatedBy,
             @SourceInspectionId, @SourceInspectionRoomId, @SourceInspectionPointId,
             @LevelName, @ExactLocation, @JobType, @SubType, @Priority
           )`,
          [
            { name: "BuildingID",              type: TYPES.Int,      value: inspection.buildingId },
            { name: "Title",                   type: TYPES.NVarChar, value: title },
            { name: "Description",             type: TYPES.NVarChar, value: description },
            { name: "AssignedTo",              type: TYPES.NVarChar, value: assignee },
            { name: "CreatedBy",               type: TYPES.NVarChar, value: caller.name },
            { name: "SourceInspectionId",      type: TYPES.Int,      value: inspectionId },
            { name: "SourceInspectionRoomId",  type: TYPES.NVarChar, value: first.roomId },
            { name: "SourceInspectionPointId", type: TYPES.NVarChar, value: isPerRoom ? null : first.pointId },
            { name: "LevelName",               type: TYPES.NVarChar, value: first.levelName },
            { name: "ExactLocation",           type: TYPES.NVarChar, value: first.roomName },
            { name: "JobType",                 type: TYPES.NVarChar, value: defaults.JobType },
            { name: "SubType",                 type: TYPES.NVarChar, value: defaults.SubType ?? null },
            { name: "Priority",                type: TYPES.NVarChar, value: defaults.Priority },
          ],
        );
        const jobId = inserted[0].JobID as number;

        // Activity feed: one creation event per job, mirroring manual creation.
        await executeQuery(
          connection,
          `INSERT INTO dbo.JobEvents (JobID, CreatedBy, EventType, CreationSource)
           VALUES (@JobID, @CreatedBy, 'creation', 'inspection')`,
          [
            { name: "JobID",     type: TYPES.Int,      value: jobId },
            { name: "CreatedBy", type: TYPES.NVarChar, value: caller.name },
          ],
        );

        // Link every contributing point and copy its attachments.
        const groupPointIds: string[] = [];
        for (const ctx of group) {
          groupPointIds.push(ctx.pointId);

          await executeQuery(
            connection,
            `INSERT INTO dbo.InspectionRaisedJobs (InspectionId, PointId, JobId, RaisedById)
             VALUES (@InspectionId, @PointId, @JobId, @RaisedById)`,
            [
              { name: "InspectionId", type: TYPES.Int,      value: inspectionId },
              { name: "PointId",      type: TYPES.NVarChar, value: ctx.pointId },
              { name: "JobId",        type: TYPES.Int,      value: jobId },
              { name: "RaisedById",   type: TYPES.NVarChar, value: caller.id },
            ],
          );

          await copyPointAttachmentsToJob(connection, ctx.pointId, jobId);
        }

        raised.push({ jobId, pointIds: groupPointIds });
      }
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }

    return { status: 200, jsonBody: { jobs: raised, pointIds } };
  } catch (error: any) {
    context.error("raiseJobsFromInspection failed:", error.message);
    return errorResponse("Failed to raise jobs", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

function buildPointIndex(inspection: InspectionApi): Map<string, PointContext> {
  const index = new Map<string, PointContext>();
  for (const lvl of inspection.levels) {
    for (const room of lvl.rooms) {
      for (const point of room.points) {
        index.set(point.id, {
          description: point.description,
          levelName: lvl.name,
          pointId: point.id,
          roomId: room.id,
          roomName: room.name,
        });
      }
    }
  }
  return index;
}

function buildJobTitle(prefix: string, levelName: string, roomName: string): string {
  const location = `${levelName} / ${roomName}`;
  return prefix ? `${prefix} ${location}` : location;
}

function buildJobDescription(group: PointContext[]): string {
  if (group.length === 1) return group[0].description;
  return group
    .map((ctx) => {
      const text = ctx.description.trim() || "(no description)";
      return `• ${text}`;
    })
    .join("\n");
}

async function copyPointAttachmentsToJob(
  connection: any,
  pointId: string,
  jobId: number,
): Promise<void> {
  // Catalogue-level copy: blob stays put, we duplicate the dbo.Attachments row
  // pointing at the same BlobName so the existing job-attachment UI surfaces
  // the inspection photos with no special-casing.
  await executeQuery(
    connection,
    `INSERT INTO dbo.Attachments (JobID, BlobName, OriginalName, UploadedBy, UploadedAt)
     SELECT @JobID, BlobName, FileName, UploadedByName, UploadedAt
       FROM dbo.InspectionAttachments
      WHERE PointId = @PointId`,
    [
      { name: "JobID",   type: TYPES.Int,      value: jobId },
      { name: "PointId", type: TYPES.NVarChar, value: pointId },
    ],
  );
}

// Suppress unused-row-type warning emitted by older toolchains.
const _SqlRowTypeReference: SqlRow = {};
void _SqlRowTypeReference;

// ── Route registration ───────────────────────────────────────────────────────

app.http("getInspections",            { authLevel: "anonymous", handler: getInspections,            methods: ["GET"] });
app.http("getInspection",             { authLevel: "anonymous", handler: getInspection,             methods: ["GET"] });
app.http("createInspection",          { authLevel: "anonymous", handler: createInspection,          methods: ["POST"] });
app.http("applyInspectionOps",        { authLevel: "anonymous", handler: applyInspectionOps,        methods: ["POST"] });
app.http("completeInspection",        { authLevel: "anonymous", handler: completeInspection,        methods: ["POST"] });
app.http("revertInspection",          { authLevel: "anonymous", handler: revertInspection,          methods: ["POST"] });
app.http("uploadInspectionAttachment",{ authLevel: "anonymous", handler: uploadInspectionAttachment,methods: ["POST"] });
app.http("mergeInspections",          { authLevel: "anonymous", handler: mergeInspections,          methods: ["POST"] });
app.http("raiseJobsFromInspection",   { authLevel: "anonymous", handler: raiseJobsFromInspection,   methods: ["POST"] });
