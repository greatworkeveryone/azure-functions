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
  AppRole,
  errorResponse,
  extractToken,
  forbiddenResponse,
  requireRole,
  rolesForRequest,
  unauthorizedResponse,
  verifiedIdentityFromRequest,
} from "../auth";
import { deleteBlob, generateReadSasUrl, uploadBlob } from "../blob-storage";
import { isAllowedContentType, MAX_SIZE_BYTES as MAX_ATTACHMENT_BYTES } from "../upload-constants";
import { checkRateLimit, RateLimitOpts } from "../rateLimit";
import { isDevOverrideEnabled } from "../jwt";

const INSPECTION_WRITE_LIMIT: RateLimitOpts = { limit: 60, windowMs: 60_000 };

// Hard ceiling on ops per /applyInspectionOps batch — bounds per-request work
// (each op is several queries inside one transaction on a Basic-tier DB).
const MAX_OPS_PER_BATCH = 200;

// Matches exactly what uploadInspectionAttachment mints via uploadBlob():
// `inspections/<uuid>` plus at most one simple extension — no extra path
// segments or dot-segments. An addAttachment op may only reference blobs that
// endpoint created; anything else (other containers' prefixes, traversal,
// double extensions) is rejected.
const INSPECTION_BLOB_NAME_PATTERN =
  /^inspections\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[A-Za-z0-9]+)?$/;

export function isValidInspectionBlobName(blobName: unknown): boolean {
  return typeof blobName === "string" && INSPECTION_BLOB_NAME_PATTERN.test(blobName);
}

// Raw failure text can leak schema/constraint detail to clients, so the per-op
// rejection reason is generic in production; dev builds keep the real message.
// The full error is always logged server-side by the caller.
export function opRejectionReason(err: unknown): string {
  if (isDevOverrideEnabled() && err instanceof Error && err.message) return err.message;
  return "Operation could not be applied";
}

function tooManyRequests(retryAfterMs: number): HttpResponseInit {
  return {
    status: 429,
    headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) },
    jsonBody: { error: "Rate limit exceeded" },
  };
}

// Inspection authors = the field inspectors plus their managers. Includes plain
// FACILITIES: they walk the building and create/edit/complete/merge inspections.
// Mirrors the frontend `editInspections` / `mergeInspections` capabilities
// (command-centre constants/roles.ts) and the deleteInspection own-row rule
// below — all three must agree on who can author an inspection.
export const EDIT_INSPECTIONS_ROLES = [
  AppRole.ADMIN,
  AppRole.DIRECTOR,
  AppRole.FACILITIES,
  AppRole.FACILITIES_APPROVAL,
] as const;

// ── Caller identity ──────────────────────────────────────────────────────────

interface UserRef { id: string; name: string }

// Caller identity is derived from verifiedIdentityFromRequest at each write
// site so the OID + display name we audit against the row always come from a
// signature-verified token. No unverified JWT body decoding here.

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

export async function getInspections(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL]);
  if (denied) return denied;

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
       ORDER BY i.Id DESC`,
      [],
    );

    // Pull structural counts for the list view. The aggregates GROUP BY
    // straight over the child tables (their FKs guarantee every row belongs to
    // an inspection in the unfiltered list above) instead of materialising one
    // SQL parameter per inspection id — which would hit SQL Server's 2100-
    // parameter cap once the list grew past ~2100 inspections.
    const levelRows = inspectionRows.length
      ? await executeQuery(
          connection,
          `SELECT InspectionId, COUNT(*) AS C FROM dbo.InspectionLevels
           GROUP BY InspectionId`,
          [],
        )
      : [];
    const levelCountByInspection = new Map(levelRows.map((r) => [r.InspectionId as number, r.C as number]));

    // Match the detail view: only count rooms that have at least one non-blank
    // inspection point. A room whose only point is the blank seed placeholder is
    // hidden in the read-only detail body, so it must not inflate the list count.
    // "Non-blank" uses the same predicate as the filled-points query below.
    const roomRows = inspectionRows.length
      ? await executeQuery(
          connection,
          `SELECT l.InspectionId, COUNT(r.Id) AS C
           FROM dbo.InspectionLevels l
           JOIN dbo.InspectionRooms r ON r.LevelId = l.Id
           WHERE EXISTS (
               SELECT 1 FROM dbo.InspectionPoints p
               WHERE p.RoomId = r.Id
                 AND LEN(LTRIM(RTRIM(ISNULL(p.Description, '')))) > 0
             )
           GROUP BY l.InspectionId`,
          [],
        )
      : [];
    const roomCountByInspection = new Map(roomRows.map((r) => [r.InspectionId as number, r.C as number]));

    const pointRows = inspectionRows.length
      ? await executeQuery(
          connection,
          `SELECT l.InspectionId, COUNT(p.Id) AS C
           FROM dbo.InspectionLevels l
           JOIN dbo.InspectionRooms r ON r.LevelId = l.Id
           JOIN dbo.InspectionPoints p ON p.RoomId = r.Id
           WHERE LEN(LTRIM(RTRIM(ISNULL(p.Description, '')))) > 0
           GROUP BY l.InspectionId`,
          [],
        )
      : [];
    const filledPointCountByInspection = new Map(pointRows.map((r) => [r.InspectionId as number, r.C as number]));

    const raisedPointRows = inspectionRows.length
      ? await executeQuery(
          connection,
          `SELECT j.InspectionId, COUNT(DISTINCT j.PointId) AS C
           FROM dbo.InspectionRaisedJobs j
           GROUP BY j.InspectionId`,
          [],
        )
      : [];
    const raisedPointCountByInspection = new Map(raisedPointRows.map((r) => [r.InspectionId as number, r.C as number]));

    // Distinct jobs created from each inspection. A single job can be raised from
    // several points (and a point can feed several jobs), so this is COUNT(DISTINCT
    // JobId) — not the same as raisedPoints (points that have any job).
    const jobRows = inspectionRows.length
      ? await executeQuery(
          connection,
          `SELECT j.InspectionId, COUNT(DISTINCT j.JobId) AS C
           FROM dbo.InspectionRaisedJobs j
           GROUP BY j.InspectionId`,
          [],
        )
      : [];
    const jobCountByInspection = new Map(jobRows.map((r) => [r.InspectionId as number, r.C as number]));

    // Build minimal-but-correct shape for list rows. Detail page calls
    // /getInspection for the full nested structure.
    const inspections: (InspectionApi & { _counts: { filledPoints: number; jobs: number; levels: number; raisedPoints: number; rooms: number } })[] =
      inspectionRows.map((i) => {
        const iid = i.Id as number;
        const out = {
          buildingId: i.BuildingId as number,
          buildingName: i.BuildingName as string,
          createdAt: toIso(i.CreatedAt),
          createdBy: { id: i.CreatedById as string, name: i.CreatedByName as string },
          id: iid,
          lastModified: toIso(i.LastModifiedAt),
          levels: [],
          revision: i.Revision as number,
          status: i.Status as "complete" | "draft" | "merged",
          title: (i.Title as string | null) ?? undefined,
          _counts: {
            filledPoints: filledPointCountByInspection.get(iid) ?? 0,
            jobs: jobCountByInspection.get(iid) ?? 0,
            levels: levelCountByInspection.get(iid) ?? 0,
            raisedPoints: raisedPointCountByInspection.get(iid) ?? 0,
            rooms: roomCountByInspection.get(iid) ?? 0,
          },
        } as InspectionApi & { _counts: { filledPoints: number; jobs: number; levels: number; raisedPoints: number; rooms: number } };
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

  const denied = await requireRole(request, [AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL]);
  if (denied) return denied;

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

  const roleCheck = await requireRole(request, EDIT_INSPECTIONS_ROLES);
  if (roleCheck) return roleCheck;

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const rl = checkRateLimit(`createInspection:${identity.oid}`, INSPECTION_WRITE_LIMIT);
  if (!rl.allowed) return tooManyRequests(rl.retryAfterMs);

  let connection;
  try {
    const body = (await request.json()) as any;
    const { BuildingId, Title } = body ?? {};
    if (!BuildingId) {
      return { status: 400, jsonBody: { error: "BuildingId required" } };
    }
    // Audit identity comes from the verified token, not unverified JWT claims.
    const caller: UserRef = { id: identity.oid, name: identity.name };

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

export async function applyInspectionOps(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roleCheck = await requireRole(request, EDIT_INSPECTIONS_ROLES);
  if (roleCheck) return roleCheck;

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const rl = checkRateLimit(`applyInspectionOps:${identity.oid}`, INSPECTION_WRITE_LIMIT);
  if (!rl.allowed) return tooManyRequests(rl.retryAfterMs);

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
    if (ops.length > MAX_OPS_PER_BATCH) {
      return { status: 400, jsonBody: { error: `Too many ops in one batch (max ${MAX_OPS_PER_BATCH})` } };
    }

    connection = await createConnection(token);

    await beginTransaction(connection);
    const applied: string[] = [];
    const rejected: { id: string; reason: string }[] = [];

    try {
      // Concurrency + status guard INSIDE the transaction: UPDLOCK/HOLDLOCK
      // holds a lock on the inspection row so neither its Revision nor its
      // Status can change between this check and the bumpRevision/commit below
      // (closes a TOCTOU window under concurrent writers).
      const rev = await executeQuery(
        connection,
        `SELECT Revision, Status FROM dbo.Inspections WITH (UPDLOCK, HOLDLOCK) WHERE Id = @Id`,
        [{ name: "Id", type: TYPES.Int, value: inspectionId }],
      );
      if (rev.length === 0) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: "Inspection not found" } };
      }
      // Completed/merged inspections are read-only — reject the whole batch.
      if (rev[0].Status !== "draft") {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 409, jsonBody: { error: "Inspection is not editable" } };
      }
      if (typeof baseRevision === "number") {
        const current = rev[0].Revision as number;
        if (current !== baseRevision) {
          await rollbackTransaction(connection).catch(() => {});
          const fresh = await loadInspection(connection, inspectionId);
          return { status: 409, jsonBody: { current: current, error: "revision-mismatch", inspection: fresh } };
        }
      }

      for (const queued of ops) {
        if (!queued.id) {
          rejected.push({ id: queued.id ?? "(missing)", reason: "op missing id" });
          continue;
        }

        // Replay check is scoped to (OpId, InspectionId): an op id logged
        // against another inspection must not be falsely reported "applied".
        const seen = await executeQuery(
          connection,
          `SELECT 1 AS X FROM dbo.InspectionOperationLog WHERE OpId = @OpId AND InspectionId = @InspectionId`,
          [
            { name: "OpId",         type: TYPES.NVarChar, value: queued.id },
            { name: "InspectionId", type: TYPES.Int,      value: inspectionId },
          ],
        );
        if (seen.length > 0) {
          // Already applied — idempotent no-op
          applied.push(queued.id);
          continue;
        }

        // Per-op savepoint: a half-applied multi-statement op (e.g. addLevel or
        // linkRooms) rolls back to here — leaving earlier successful ops intact —
        // instead of committing torn state with the rest of the batch.
        await executeQuery(connection, "SAVE TRANSACTION op_sp", []);
        try {
          await applyOne(connection, inspectionId, queued.op, identity);
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
          await executeQuery(connection, "ROLLBACK TRANSACTION op_sp", []).catch(() => {});
          context.error(`op ${queued.id} (${queued.op?.type}) failed:`, err);
          rejected.push({ id: queued.id, reason: opRejectionReason(err) });
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

async function applyOne(
  connection: any,
  inspectionId: number,
  op: any,
  identity: { oid: string; name: string },
): Promise<void> {
  switch (op?.type) {
    case "updateInspection": {
      // Only the title is patchable at inspection level. An explicit
      // `title: null` (or an empty/whitespace-only string) clears it;
      // Title is NVARCHAR(200) per m034.
      const rawTitle = op.patch?.title;
      if (rawTitle !== null && typeof rawTitle !== "string") {
        throw new Error("updateInspection requires patch.title as a string or null");
      }
      const title = typeof rawTitle === "string" ? rawTitle.trim() : null;
      if (title !== null && title.length > 200) {
        throw new Error("updateInspection: title exceeds 200 characters");
      }
      await executeQuery(
        connection,
        `UPDATE dbo.Inspections SET Title = @Title WHERE Id = @InspectionId`,
        [
          { name: "Title",        type: TYPES.NVarChar, value: title || null },
          { name: "InspectionId", type: TYPES.Int,      value: inspectionId },
        ],
      );
      return;
    }
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
          // Audit provenance comes from the verified token, never the client op.
          { name: "UserId",   type: TYPES.NVarChar, value: identity.oid },
          { name: "UserName", type: TYPES.NVarChar, value: identity.name },
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
        // INSERT…SELECT scopes the room to a level in THIS inspection: a forged
        // levelId from another inspection matches no row and inserts nothing.
        `INSERT INTO dbo.InspectionRooms (Id, LevelId, Name, Description, AddedAt, AddedById, AddedByName)
         SELECT @Id, @LevelId, @Name, @Description, @AddedAt, @AddedById, @AddedByName
         FROM dbo.InspectionLevels l
         WHERE l.Id = @LevelId AND l.InspectionId = @InspectionId;
         IF @@ROWCOUNT = 0 THROW 50409, 'addRoom: level not found in this inspection', 1;`,
        [
          { name: "Id",           type: TYPES.NVarChar, value: op.roomId },
          { name: "LevelId",      type: TYPES.NVarChar, value: op.levelId },
          { name: "Name",         type: TYPES.NVarChar, value: op.name },
          { name: "Description",  type: TYPES.NVarChar, value: op.description ?? null },
          { name: "AddedAt",      type: TYPES.NVarChar, value: op.addedAt },
          { name: "AddedById",    type: TYPES.NVarChar, value: identity.oid },
          { name: "AddedByName",  type: TYPES.NVarChar, value: identity.name },
          { name: "InspectionId", type: TYPES.Int,      value: inspectionId },
        ],
      );
      return;
    }
    case "updateRoom": {
      const fields: string[] = [];
      const params: { name: string; type: typeof TYPES.NVarChar | typeof TYPES.Int; value: unknown }[] = [
        { name: "RoomId",       type: TYPES.NVarChar, value: op.roomId },
        { name: "InspectionId", type: TYPES.Int,      value: inspectionId },
      ];
      if (op.patch?.name !== undefined) {
        fields.push("Name = @Name");
        params.push({ name: "Name", type: TYPES.NVarChar, value: op.patch.name });
      }
      if (op.patch?.description !== undefined) {
        fields.push("Description = @Description");
        params.push({ name: "Description", type: TYPES.NVarChar, value: op.patch.description ?? null });
      }
      if (fields.length === 0) return;
      // Scope the UPDATE to the caller's inspection. Without this an op
      // forged on the client could rename a room belonging to another
      // inspection just by knowing/guessing its UUID. JOIN through
      // InspectionLevels asserts the Room → Level → Inspection chain.
      await executeQuery(
        connection,
        `UPDATE r
           SET ${fields.join(", ")}
         FROM dbo.InspectionRooms r
         JOIN dbo.InspectionLevels l ON l.Id = r.LevelId
         WHERE r.Id = @RoomId AND l.InspectionId = @InspectionId`,
        params,
      );
      return;
    }
    case "removeRoom": {
      await executeQuery(
        connection,
        `DELETE r
         FROM dbo.InspectionRooms r
         JOIN dbo.InspectionLevels l ON l.Id = r.LevelId
         WHERE r.Id = @Id AND l.InspectionId = @InspectionId`,
        [
          { name: "Id",           type: TYPES.NVarChar, value: op.roomId },
          { name: "InspectionId", type: TYPES.Int,      value: inspectionId },
        ],
      );
      return;
    }
    case "addPoint": {
      await executeQuery(
        connection,
        // INSERT…SELECT scopes the point to a room in THIS inspection: a forged
        // roomId from another inspection matches no row and inserts nothing.
        `INSERT INTO dbo.InspectionPoints (Id, RoomId, Description, AddedAt, AddedById, AddedByName, LastModifiedAt)
         SELECT @Id, @RoomId, @Description, @AddedAt, @AddedById, @AddedByName, @AddedAt
         FROM dbo.InspectionRooms  r
         JOIN dbo.InspectionLevels l ON l.Id = r.LevelId
         WHERE r.Id = @RoomId AND l.InspectionId = @InspectionId;
         IF @@ROWCOUNT = 0 THROW 50409, 'addPoint: room not found in this inspection', 1;`,
        [
          { name: "Id",           type: TYPES.NVarChar, value: op.pointId },
          { name: "RoomId",       type: TYPES.NVarChar, value: op.roomId },
          { name: "Description",  type: TYPES.NVarChar, value: op.description ?? "" },
          { name: "AddedAt",      type: TYPES.NVarChar, value: op.addedAt },
          { name: "AddedById",    type: TYPES.NVarChar, value: identity.oid },
          { name: "AddedByName",  type: TYPES.NVarChar, value: identity.name },
          { name: "InspectionId", type: TYPES.Int,      value: inspectionId },
        ],
      );
      return;
    }
    case "updatePoint": {
      if (op.patch?.description === undefined) {
        throw new Error("updatePoint requires patch.description");
      }
      // JOIN Point → Room → Level → Inspection so the WHERE asserts the
      // point actually lives under the inspection this op claims to mutate.
      await executeQuery(
        connection,
        `UPDATE p
           SET Description = @Description, LastModifiedAt = SYSUTCDATETIME()
         FROM dbo.InspectionPoints p
         JOIN dbo.InspectionRooms  r ON r.Id = p.RoomId
         JOIN dbo.InspectionLevels l ON l.Id = r.LevelId
         WHERE p.Id = @Id AND l.InspectionId = @InspectionId`,
        [
          { name: "Id",           type: TYPES.NVarChar, value: op.pointId },
          { name: "InspectionId", type: TYPES.Int,      value: inspectionId },
          { name: "Description",  type: TYPES.NVarChar, value: op.patch.description },
        ],
      );
      return;
    }
    case "removePoint": {
      await executeQuery(
        connection,
        `DELETE p
         FROM dbo.InspectionPoints p
         JOIN dbo.InspectionRooms  r ON r.Id = p.RoomId
         JOIN dbo.InspectionLevels l ON l.Id = r.LevelId
         WHERE p.Id = @Id AND l.InspectionId = @InspectionId`,
        [
          { name: "Id",           type: TYPES.NVarChar, value: op.pointId },
          { name: "InspectionId", type: TYPES.Int,      value: inspectionId },
        ],
      );
      return;
    }
    case "addAttachment": {
      // Only blobs minted by /uploadInspectionAttachment may be catalogued —
      // an arbitrary client-supplied name could alias another container path
      // (job attachments, PO PDFs, …) into this inspection.
      if (!isValidInspectionBlobName(op.blobName)) {
        throw new Error("addAttachment: blobName is not an inspection upload");
      }
      // Guard the insert: the target Point must belong to this inspection.
      // Conditional INSERT … SELECT lets us assert the chain in a single
      // round trip without a separate existence query.
      await executeQuery(
        connection,
        `INSERT INTO dbo.InspectionAttachments
           (Id, PointId, BlobName, FileName, UploadedAt, UploadedById, UploadedByName)
         SELECT @Id, @PointId, @BlobName, @FileName, @UploadedAt, @UploadedById, @UploadedByName
         FROM dbo.InspectionPoints p
         JOIN dbo.InspectionRooms  r ON r.Id = p.RoomId
         JOIN dbo.InspectionLevels l ON l.Id = r.LevelId
         WHERE p.Id = @PointId AND l.InspectionId = @InspectionId`,
        [
          { name: "Id",             type: TYPES.NVarChar, value: op.attachmentId },
          { name: "PointId",        type: TYPES.NVarChar, value: op.pointId },
          { name: "InspectionId",   type: TYPES.Int,      value: inspectionId },
          { name: "BlobName",       type: TYPES.NVarChar, value: op.blobName },
          { name: "FileName",       type: TYPES.NVarChar, value: op.fileName },
          { name: "UploadedAt",     type: TYPES.NVarChar, value: op.uploadedAt },
          // Audit provenance comes from the verified token, never the client op.
          { name: "UploadedById",   type: TYPES.NVarChar, value: identity.oid },
          { name: "UploadedByName", type: TYPES.NVarChar, value: identity.name },
        ],
      );
      return;
    }
    case "removeAttachment": {
      // Scope both the BlobName lookup and the DELETE to this inspection via
      // the Point → Room → Level chain. Without it any attachment Id from
      // another inspection could be deleted.
      const rows = await executeQuery(
        connection,
        `SELECT a.BlobName
         FROM dbo.InspectionAttachments a
         JOIN dbo.InspectionPoints p ON p.Id = a.PointId
         JOIN dbo.InspectionRooms  r ON r.Id = p.RoomId
         JOIN dbo.InspectionLevels l ON l.Id = r.LevelId
         WHERE a.Id = @Id AND l.InspectionId = @InspectionId`,
        [
          { name: "Id",           type: TYPES.NVarChar, value: op.attachmentId },
          { name: "InspectionId", type: TYPES.Int,      value: inspectionId },
        ],
      );
      const blobName = rows[0]?.BlobName as string | undefined;
      await executeQuery(
        connection,
        `DELETE a
         FROM dbo.InspectionAttachments a
         JOIN dbo.InspectionPoints p ON p.Id = a.PointId
         JOIN dbo.InspectionRooms  r ON r.Id = p.RoomId
         JOIN dbo.InspectionLevels l ON l.Id = r.LevelId
         WHERE a.Id = @Id AND l.InspectionId = @InspectionId`,
        [
          { name: "Id",           type: TYPES.NVarChar, value: op.attachmentId },
          { name: "InspectionId", type: TYPES.Int,      value: inspectionId },
        ],
      );
      // Defence in depth: never destroy a blob outside this feature's prefix,
      // even if a legacy row catalogued one.
      if (blobName && blobName.startsWith("inspections/")) {
        try { await deleteBlob(blobName); } catch { /* best effort — orphan blob isn't fatal */ }
      }
      return;
    }
    case "linkRooms": {
      const roomIds: string[] = Array.isArray(op.roomIds) ? op.roomIds : [];
      if (roomIds.length < 2) {
        throw new Error("linkRooms requires at least two roomIds");
      }
      const [keeperId, ...sourceIds] = roomIds;

      // Guard: the keeper must live on the named level of THIS inspection.
      const keeperRows = await executeQuery(
        connection,
        `SELECT 1
         FROM dbo.InspectionRooms r
         JOIN dbo.InspectionLevels l ON l.Id = r.LevelId
         WHERE r.Id = @Keeper AND r.LevelId = @LevelId AND l.InspectionId = @InspectionId`,
        [
          { name: "Keeper",       type: TYPES.NVarChar, value: keeperId },
          { name: "LevelId",      type: TYPES.NVarChar, value: op.levelId },
          { name: "InspectionId", type: TYPES.Int,      value: inspectionId },
        ],
      );
      if (keeperRows.length === 0) {
        throw new Error("linkRooms keeper is not on the named level of this inspection");
      }

      // Re-parent each source room's points into the keeper. The Room->Level
      // chain + LevelId/InspectionId scoping makes a cross-inspection or
      // cross-floor source id a harmless no-op.
      for (const sourceId of sourceIds) {
        await executeQuery(
          connection,
          `UPDATE p
             SET p.RoomId = @Keeper
           FROM dbo.InspectionPoints p
           JOIN dbo.InspectionRooms  r ON r.Id = p.RoomId
           JOIN dbo.InspectionLevels l ON l.Id = r.LevelId
           WHERE p.RoomId = @Source AND r.LevelId = @LevelId AND l.InspectionId = @InspectionId`,
          [
            { name: "Keeper",       type: TYPES.NVarChar, value: keeperId },
            { name: "Source",       type: TYPES.NVarChar, value: sourceId },
            { name: "LevelId",      type: TYPES.NVarChar, value: op.levelId },
            { name: "InspectionId", type: TYPES.Int,      value: inspectionId },
          ],
        );
        await executeQuery(
          connection,
          `DELETE r
           FROM dbo.InspectionRooms r
           JOIN dbo.InspectionLevels l ON l.Id = r.LevelId
           WHERE r.Id = @Source AND r.LevelId = @LevelId AND l.InspectionId = @InspectionId`,
          [
            { name: "Source",       type: TYPES.NVarChar, value: sourceId },
            { name: "LevelId",      type: TYPES.NVarChar, value: op.levelId },
            { name: "InspectionId", type: TYPES.Int,      value: inspectionId },
          ],
        );
      }

      // Renumber the keeper's points by AddedAt so the reloaded order
      // (ORDER BY SortOrder, AddedAt) matches the optimistic client order.
      await executeQuery(
        connection,
        `;WITH ordered AS (
           SELECT p.Id, ROW_NUMBER() OVER (ORDER BY p.AddedAt, p.Id) AS rn
           FROM dbo.InspectionPoints p
           JOIN dbo.InspectionRooms  r ON r.Id = p.RoomId
           JOIN dbo.InspectionLevels l ON l.Id = r.LevelId
           WHERE p.RoomId = @Keeper AND l.InspectionId = @InspectionId
         )
         UPDATE p SET p.SortOrder = o.rn
         FROM dbo.InspectionPoints p
         JOIN ordered o ON o.Id = p.Id`,
        [
          { name: "Keeper",       type: TYPES.NVarChar, value: keeperId },
          { name: "InspectionId", type: TYPES.Int,      value: inspectionId },
        ],
      );
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

export async function completeInspection(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roleCheck = await requireRole(request, EDIT_INSPECTIONS_ROLES);
  if (roleCheck) return roleCheck;

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const rl = checkRateLimit(`completeInspection:${identity.oid}`, INSPECTION_WRITE_LIMIT);
  if (!rl.allowed) return tooManyRequests(rl.retryAfterMs);

  let connection;
  try {
    const body = (await request.json()) as any;
    const inspectionId: number | undefined = body?.InspectionId ?? body?.inspectionId;
    if (!inspectionId) return { status: 400, jsonBody: { error: "InspectionId required" } };
    const caller: UserRef = { id: identity.oid, name: identity.name };

    connection = await createConnection(token);

    const rows = await executeQuery(
      connection,
      `SELECT Status FROM dbo.Inspections WHERE Id = @Id`,
      [{ name: "Id", type: TYPES.Int, value: inspectionId }],
    );
    if (rows.length === 0) return { status: 404, jsonBody: { error: "Inspection not found" } };
    const status = rows[0].Status as string;
    if (status === "merged") {
      return { status: 400, jsonBody: { error: "Merged inspections cannot be completed" } };
    }
    // Already complete → idempotent no-op: return the current row unchanged.
    if (status === "draft") {
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
    }
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

  const roleCheck = await requireRole(request, EDIT_INSPECTIONS_ROLES);
  if (roleCheck) return roleCheck;

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const rl = checkRateLimit(`revertInspection:${identity.oid}`, INSPECTION_WRITE_LIMIT);
  if (!rl.allowed) return tooManyRequests(rl.retryAfterMs);

  let connection;
  try {
    const body = (await request.json()) as any;
    const inspectionId: number | undefined = body?.InspectionId ?? body?.inspectionId;
    if (!inspectionId) return { status: 400, jsonBody: { error: "InspectionId required" } };

    connection = await createConnection(token);

    // Ownership gate: base editors may only reopen an inspection they created;
    // admin / director / facilities_approval may reopen any (mirrors the
    // own-row gate in deleteInspection).
    const rows = await executeQuery(
      connection,
      `SELECT CreatedById FROM dbo.Inspections WHERE Id = @Id`,
      [{ name: "Id", type: TYPES.Int, value: inspectionId }],
    );
    if (rows.length === 0) return { status: 404, jsonBody: { error: "Inspection not found" } };
    const roles = await rolesForRequest(request);
    const canRevertAny =
      roles.includes(AppRole.ADMIN) ||
      roles.includes(AppRole.DIRECTOR) ||
      roles.includes(AppRole.FACILITIES_APPROVAL);
    if (!canRevertAny && rows[0].CreatedById !== identity.oid) {
      return forbiddenResponse("You can only reopen inspections you created.");
    }

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

export async function uploadInspectionAttachment(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roleCheck = await requireRole(request, EDIT_INSPECTIONS_ROLES);
  if (roleCheck) return roleCheck;

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const rl = checkRateLimit(`uploadInspectionAttachment:${identity.oid}`, INSPECTION_WRITE_LIMIT);
  if (!rl.allowed) return tooManyRequests(rl.retryAfterMs);

  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    if (!file) return { status: 400, jsonBody: { error: "'file' field required" } };
    // Same allow-list every other upload endpoint enforces (attachments.ts,
    // keys.ts, tenancyAttachments.ts). Camera uploads sometimes arrive with no
    // type — default those to JPEG rather than octet-stream.
    const contentType = file.type || "image/jpeg";
    if (!isAllowedContentType(contentType)) {
      return { status: 415, jsonBody: { error: `File type '${contentType}' is not allowed` } };
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return {
        status: 413,
        jsonBody: {
          error: `Attachment exceeds ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB limit`,
          code: "ATTACHMENT_TOO_LARGE",
        },
      };
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await uploadBlob(buffer, file.name, contentType, "inspections");
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

// ── POST /api/deleteInspection ───────────────────────────────────────────────
// Body: { InspectionId: number }
// Only draft inspections can be deleted. Blobs are orphaned (no storage cleanup here).

export async function deleteInspection(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roleCheck = await requireRole(request, EDIT_INSPECTIONS_ROLES);
  if (roleCheck) return roleCheck;

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const rl = checkRateLimit(`deleteInspection:${identity.oid}`, INSPECTION_WRITE_LIMIT);
  if (!rl.allowed) return tooManyRequests(rl.retryAfterMs);

  let connection;
  try {
    const body = (await request.json()) as any;
    const { InspectionId } = body ?? {};
    if (!InspectionId) return { status: 400, jsonBody: { error: "InspectionId required" } };

    connection = await createConnection(token);

    const rows = await executeQuery(
      connection,
      `SELECT Id, Status, CreatedById FROM dbo.Inspections WHERE Id = @Id`,
      [{ name: "Id", type: TYPES.Int, value: InspectionId }],
    );
    if (rows.length === 0) return { status: 404, jsonBody: { error: "Inspection not found" } };
    if (rows[0].Status !== "draft") {
      return { status: 400, jsonBody: { error: "Only draft inspections can be deleted" } };
    }

    // Ownership gate: base editors may only delete an inspection they created;
    // admin / director / facilities_approval may delete any (mirrors the
    // own-row gate in revertInspection).
    const roles = await rolesForRequest(request);
    const canDeleteAny =
      roles.includes(AppRole.ADMIN) ||
      roles.includes(AppRole.DIRECTOR) ||
      roles.includes(AppRole.FACILITIES_APPROVAL);
    if (!canDeleteAny && rows[0].CreatedById !== identity.oid) {
      return forbiddenResponse("You can only delete inspections you created.");
    }

    // Delete non-cascading child rows first, then the root (which cascades to
    // levels → rooms → points → attachments). All four run in one transaction
    // so a mid-sequence failure can't leave a half-deleted inspection behind.
    await beginTransaction(connection);
    try {
      await executeQuery(
        connection,
        `DELETE FROM dbo.InspectionRaisedJobs WHERE InspectionId = @Id`,
        [{ name: "Id", type: TYPES.Int, value: InspectionId }],
      );
      await executeQuery(
        connection,
        `DELETE FROM dbo.InspectionOperationLog WHERE InspectionId = @Id`,
        [{ name: "Id", type: TYPES.Int, value: InspectionId }],
      );
      await executeQuery(
        connection,
        `DELETE FROM dbo.InspectionMergeSources WHERE MergedInspectionId = @Id OR SourceInspectionId = @Id`,
        [{ name: "Id", type: TYPES.Int, value: InspectionId }],
      );
      // If this row is a merge target, the source husks still reference it via
      // Inspections.MergedIntoId (FK, m034) and would make the root DELETE fail
      // with an FK violation. Detach them and revert them to draft so they
      // render as normal drafts and become individually deletable again.
      await executeQuery(
        connection,
        `UPDATE dbo.Inspections
         SET MergedIntoId = NULL, Status = 'draft', LastModifiedAt = SYSUTCDATETIME()
         WHERE MergedIntoId = @Id`,
        [{ name: "Id", type: TYPES.Int, value: InspectionId }],
      );
      await executeQuery(
        connection,
        `DELETE FROM dbo.Inspections WHERE Id = @Id`,
        [{ name: "Id", type: TYPES.Int, value: InspectionId }],
      );
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }

    context.log(`deleteInspection: deleted inspection ${InspectionId}`);
    return { status: 200, jsonBody: { deleted: true } };
  } catch (error: any) {
    context.error("deleteInspection failed:", error.message);
    return errorResponse("Failed to delete inspection", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/mergeInspections ───────────────────────────────────────────────
// Body: { SourceIds: number[], Title?: string }

export async function mergeInspections(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roleCheck = await requireRole(request, EDIT_INSPECTIONS_ROLES);
  if (roleCheck) return roleCheck;

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const rl = checkRateLimit(`mergeInspections:${identity.oid}`, INSPECTION_WRITE_LIMIT);
  if (!rl.allowed) return tooManyRequests(rl.retryAfterMs);

  let connection;
  try {
    const body = (await request.json()) as any;
    const sourceIds: number[] = Array.isArray(body?.SourceIds) ? body.SourceIds : [];
    const title: string | undefined = body?.Title;
    if (sourceIds.length < 2) {
      return { status: 400, jsonBody: { error: "SourceIds (at least 2) required" } };
    }
    const caller: UserRef = { id: identity.oid, name: identity.name };

    connection = await createConnection(token);

    const placeholders = sourceIds.map((_, idx) => `@S${idx}`).join(",");
    const params = sourceIds.map((id, idx) => ({ name: `S${idx}`, type: TYPES.Int, value: id }));

    await beginTransaction(connection);
    try {
      // Validate sources under a row lock (UPDLOCK/HOLDLOCK) so a concurrent
      // completeInspection or merge can't change their status or building
      // between this check and the merge below.
      const sourceRows = await executeQuery(
        connection,
        `SELECT Id, BuildingId, Status, CreatedById FROM dbo.Inspections WITH (UPDLOCK, HOLDLOCK) WHERE Id IN (${placeholders})`,
        params,
      );
      if (sourceRows.length !== sourceIds.length) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: "One or more source inspections not found" } };
      }
      // Ownership gate: base editors may only merge drafts they all created;
      // admin / director / facilities_approval may merge any (mirrors the
      // own-row gate in revertInspection / deleteInspection — a merge consumes
      // its sources irreversibly).
      const roles = await rolesForRequest(request);
      const canMergeAny =
        roles.includes(AppRole.ADMIN) ||
        roles.includes(AppRole.DIRECTOR) ||
        roles.includes(AppRole.FACILITIES_APPROVAL);
      if (!canMergeAny && sourceRows.some((r) => r.CreatedById !== identity.oid)) {
        await rollbackTransaction(connection).catch(() => {});
        return forbiddenResponse("You can only merge inspections you created.");
      }
      if (sourceRows.some((r) => r.Status !== "draft")) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 400, jsonBody: { error: "Only draft inspections can be merged" } };
      }
      const buildingIds = new Set(sourceRows.map((r) => r.BuildingId as number));
      if (buildingIds.size > 1) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 400, jsonBody: { error: "All sources must be in the same building" } };
      }
      const buildingId = sourceRows[0].BuildingId as number;
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

      // Re-parent raised-job links and job backlinks onto the merge target —
      // loadInspection and the list counts join on InspectionId /
      // SourceInspectionId, so without this the merged inspection loses all
      // raised-job linkage.
      await executeQuery(
        connection,
        `UPDATE dbo.InspectionRaisedJobs SET InspectionId = @TargetId WHERE InspectionId IN (${placeholders})`,
        [...params, { name: "TargetId", type: TYPES.Int, value: newId }],
      );
      await executeQuery(
        connection,
        `UPDATE dbo.Jobs SET SourceInspectionId = @TargetId WHERE SourceInspectionId IN (${placeholders})`,
        [...params, { name: "TargetId", type: TYPES.Int, value: newId }],
      );

      // Drop the now-empty source levels (rooms have been re-parented).
      await executeQuery(
        connection,
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

export async function raiseJobsFromInspection(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roleCheck = await requireRole(request, EDIT_INSPECTIONS_ROLES);
  if (roleCheck) return roleCheck;

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const rl = checkRateLimit(`raiseJobsFromInspection:${identity.oid}`, INSPECTION_WRITE_LIMIT);
  if (!rl.allowed) return tooManyRequests(rl.retryAfterMs);

  let connection;
  try {
    const body = (await request.json()) as RaiseJobsBody;
    const inspectionId = body?.InspectionId;
    const pointIds = Array.isArray(body?.PointIds) ? body.PointIds : [];
    const mode = body?.Mode ?? "per-point";
    const defaults = body?.Defaults ?? {};

    if (!inspectionId || pointIds.length === 0) {
      return { status: 400, jsonBody: { error: "InspectionId and PointIds[] required" } };
    }
    if (mode !== "per-point" && mode !== "per-room") {
      return { status: 400, jsonBody: { error: "Mode must be 'per-point' or 'per-room'" } };
    }
    if (!defaults.JobType || !defaults.Priority) {
      return { status: 400, jsonBody: { error: "Defaults.JobType and Defaults.Priority required" } };
    }

    const caller: UserRef = { id: identity.oid, name: identity.name };
    const descriptionPrefix = (defaults.DescriptionPrefix ?? "").trim();
    const assignee = (defaults.AssigneeName ?? "").trim() || caller.name;

    connection = await createConnection(token);

    // Hydrate inspection state from the DB — never trust the client for the
    // text/level/room fields that go onto a real Job.
    const inspection = await loadInspection(connection, inspectionId);
    if (!inspection) {
      return { status: 404, jsonBody: { error: "Inspection not found" } };
    }
    // Jobs are raised from the read-only review of a completed walkthrough —
    // mirrors the frontend, which only offers this on completed inspections.
    if (inspection.status !== "complete") {
      return { status: 400, jsonBody: { error: "Jobs can only be raised from a completed inspection" } };
    }

    const pointIndex = buildPointIndex(inspection);
    const missing = pointIds.filter((id) => !pointIndex.has(id));
    if (missing.length > 0) {
      return {
        status: 400,
        jsonBody: { error: `Unknown pointId(s): ${missing.join(", ")}` },
      };
    }

    // Group selected points into one batch per Job-to-create. The `missing`
    // check above already rejected any id not in pointIndex, so a fresh lookup
    // here can only miss if the inspection was mutated concurrently — in that
    // case bail with a 409 rather than crashing on a non-null assertion.
    const groups: PointContext[][] = [];
    if (mode === "per-room") {
      const byRoom = new Map<string, PointContext[]>();
      for (const id of pointIds) {
        const ctx = pointIndex.get(id);
        if (!ctx) {
          return { status: 409, jsonBody: { error: `Point ${id} no longer exists`, code: "POINT_GONE" } };
        }
        const list = byRoom.get(ctx.roomId);
        if (list) list.push(ctx);
        else byRoom.set(ctx.roomId, [ctx]);
      }
      for (const list of byRoom.values()) groups.push(list);
    } else {
      for (const id of pointIds) {
        const ctx = pointIndex.get(id);
        if (!ctx) {
          return { status: 409, jsonBody: { error: `Point ${id} no longer exists`, code: "POINT_GONE" } };
        }
        groups.push([ctx]);
      }
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
app.http("deleteInspection",          { authLevel: "anonymous", handler: deleteInspection,          methods: ["POST"] });
app.http("uploadInspectionAttachment",{ authLevel: "anonymous", handler: uploadInspectionAttachment,methods: ["POST"] });
app.http("mergeInspections",          { authLevel: "anonymous", handler: mergeInspections,          methods: ["POST"] });
app.http("raiseJobsFromInspection",   { authLevel: "anonymous", handler: raiseJobsFromInspection,   methods: ["POST"] });
