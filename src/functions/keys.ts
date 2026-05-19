// Keys — CRUD for key/code registrations, batch checkout, and check-in.
// Photos are uploaded via uploadKeyPhoto before the checkout/checkin payload
// is submitted; callers include the returned URL in their request body.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import ExcelJS from "exceljs";
import { TYPES } from "tedious";
import { createConnection, createServiceConnection, executeQuery, closeConnection } from "../db";
import {
  extractToken,
  unauthorizedResponse,
  errorResponse,
  requireRole,
  oidFromToken,
} from "../auth";
import { uploadBlob, generateReadSasUrl } from "../blob-storage";

const BULK_CREATE_ROLES = ["Admin", "timesheet_approval_facilities"] as const;
const EDIT_KEYS_ROLES   = ["Admin", "facilities", "timesheet_approval_facilities"] as const;

// ── Caller identity ─────────────────────────────────────────────────────────
// Mirrors the pattern in inspections.ts. We store both the stable Entra OID
// and the display name so audit rows remain readable if a user is renamed.

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

const KEY_STORAGE_LOCATIONS = [
  "Randazzo Properties Office",
  "Randazzo Center (Harry Potter Room)",
  "9 Cavanagh (Plant Room)",
  "66 Smith (Plant Room)",
  "Bov Plaza (Site Office)",
] as const;

const KEY_SUB_TYPES = [
  "Normal", "BiLock", "Dimpled", "Safe", "Laser Tracked", "Cylinder",
  "Tubular", "Window", "Fob (RFID)", "Keycard", "Padlock", "ABLOY", "Lockwood",
] as const;

const CODE_SUB_TYPES = [
  "Door Code", "Mechanical Code Lock", "Electronic Keypad", "Smart Lock", "Padlock/Chain",
] as const;

const ITEM_TYPES = ["key", "code"] as const;
const REGISTRATIONS = ["standard", "registered"] as const;

// ── Notification stub ────────────────────────────────────────────────────────
// TODO: send Graph API email to key manager when key is overdue
async function notifyOverdueKey(_keyId: number): Promise<void> {
  return;
}

// ── Column helpers ───────────────────────────────────────────────────────────

const KEY_COLUMNS = `
  k.Id, k.BuildingId, b.BuildingName,
  k.TenancyId, t.LegalName AS TenancyName,
  k.Level, k.KeyNumber, k.ItemType, k.SubType, k.Registration,
  k.Description, k.PhotoBlobUrl, k.StorageLocation,
  k.DateAdded, k.Status,
  k.CreatedById, k.CreatedByName, k.CreatedAt,
  k.IsDeleted, k.DeletedAt, k.DeletedById, k.DeletedByName,
  k.LostAt, k.LostById, k.LostByName, k.LostComment
`;

// Photo SAS URLs are baked into list/detail responses. 4h was tight — a user
// who opened the page in the morning would see broken images by mid-afternoon.
// 24h lasts a working day comfortably without raising the surface area much.
const PHOTO_SAS_TTL_MS = 24 * 60 * 60 * 1000;

const BATCH_COLUMNS = `
  kb.Id AS BatchId, kb.CheckedOutBy, kb.CheckedOutTo,
  kb.CheckedOutAt, kb.ExpectedReturnAt, kb.CheckOutPhotoBlobUrl, kb.Notes,
  CASE WHEN kc2.CheckedInAt IS NULL AND kb.ExpectedReturnAt < SYSUTCDATETIME()
       THEN 1 ELSE 0 END AS IsOverdue
`;

function formatKey(row: Record<string, unknown>) {
  return {
    id: row.Id,
    buildingId: row.BuildingId,
    buildingName: row.BuildingName,
    tenancyId: row.TenancyId ?? null,
    tenancyName: row.TenancyName ?? null,
    level: row.Level,
    keyNumber: row.KeyNumber,
    itemType: row.ItemType,
    subType: row.SubType ?? null,
    registration: row.Registration,
    description: row.Description,
    photoUrl: row.PhotoBlobUrl
      ? generateReadSasUrl(row.PhotoBlobUrl as string, PHOTO_SAS_TTL_MS)
      : null,
    storageLocation: row.StorageLocation ?? null,
    dateAdded: row.DateAdded,
    status: row.Status,
    createdBy: row.CreatedById
      ? { id: row.CreatedById as string, name: (row.CreatedByName as string) ?? "Unknown user" }
      : null,
    createdAt: row.CreatedAt ?? null,
    isDeleted: row.IsDeleted === 1 || row.IsDeleted === true,
    deletedAt: row.DeletedAt ?? null,
    deletedBy: row.DeletedById
      ? { id: row.DeletedById as string, name: (row.DeletedByName as string) ?? "Unknown user" }
      : null,
    lostAt: row.LostAt ?? null,
    lostBy: row.LostById
      ? { id: row.LostById as string, name: (row.LostByName as string) ?? "Unknown user" }
      : null,
    lostComment: (row.LostComment as string | null) ?? null,
  };
}

// ── GET /api/getKeys ──────────────────────────────────────────────────────────

async function getKeys(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    connection = await createConnection(token);

    // OUTER APPLY pulls the single most-recent open batch per key so the row
    // count stays 1:1 with dbo.Keys. Codes can have several concurrent open
    // shares; a plain LEFT JOIN would fan them out into duplicate rows.
    const rows = await executeQuery(
      connection,
      `SELECT
         ${KEY_COLUMNS},
         cb.BatchId,
         cb.CheckedOutBy, cb.CheckedOutTo,
         cb.CheckedOutAt, cb.ExpectedReturnAt,
         cb.CheckOutPhotoBlobUrl, cb.Notes,
         CASE WHEN cb.BatchId IS NOT NULL AND cb.ExpectedReturnAt < SYSUTCDATETIME()
           THEN 1 ELSE 0 END AS IsOverdue
       FROM dbo.Keys k
       JOIN dbo.Buildings b ON b.BuildingID = k.BuildingId
       LEFT JOIN dbo.Tenants t ON t.TenantID = k.TenancyId
       OUTER APPLY (
         SELECT TOP 1
           kb.Id AS BatchId,
           kb.CheckedOutBy, kb.CheckedOutTo,
           kb.CheckedOutAt, kb.ExpectedReturnAt,
           kb.CheckOutPhotoBlobUrl, kb.Notes
         FROM dbo.KeyCheckouts kco
         JOIN dbo.KeyCheckoutBatches kb ON kb.Id = kco.BatchId
         WHERE kco.KeyId = k.Id AND kco.CheckedInAt IS NULL
         ORDER BY kb.CheckedOutAt DESC
       ) cb
       WHERE k.IsDeleted = 0
       ORDER BY b.BuildingName, k.KeyNumber`,
      [],
    );

    // Fetch all open checkout rows to attach to batches
    const openCheckouts = await executeQuery(
      connection,
      `SELECT kco.Id, kco.BatchId, kco.KeyId, kco.CheckedInAt, kco.CheckInPhotoBlobUrl
       FROM dbo.KeyCheckouts kco
       WHERE kco.CheckedInAt IS NULL`,
      [],
    );

    const checkoutsByBatch = new Map<number, typeof openCheckouts>();
    for (const co of openCheckouts) {
      const bid = co.BatchId as number;
      if (!checkoutsByBatch.has(bid)) checkoutsByBatch.set(bid, []);
      checkoutsByBatch.get(bid)!.push(co);
    }

    const keys = rows.map((row) => {
      const base = formatKey(row);
      const batchId = row.BatchId as number | null;
      const currentBatch = batchId
        ? {
            id: batchId,
            checkedOutBy: row.CheckedOutBy,
            checkedOutTo: row.CheckedOutTo,
            checkedOutAt: row.CheckedOutAt,
            expectedReturnAt: row.ExpectedReturnAt,
            checkOutPhotoUrl: row.CheckOutPhotoBlobUrl
              ? generateReadSasUrl(row.CheckOutPhotoBlobUrl as string, 4 * 60 * 60 * 1000)
              : null,
            notes: row.Notes ?? null,
            isOverdue: row.IsOverdue === 1,
            checkouts: (checkoutsByBatch.get(batchId) ?? []).map((co) => ({
              id: co.Id,
              batchId: co.BatchId,
              keyId: co.KeyId,
              checkedInAt: co.CheckedInAt ?? null,
              checkInPhotoUrl: co.CheckInPhotoBlobUrl
                ? generateReadSasUrl(co.CheckInPhotoBlobUrl as string, 4 * 60 * 60 * 1000)
                : null,
            })),
          }
        : null;
      return { ...base, currentBatch };
    });

    return { status: 200, jsonBody: { count: keys.length, keys } };
  } catch (error: any) {
    context.error("getKeys failed:", error.message);
    return errorResponse("Failed to fetch keys", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── GET /api/getKeyDetail?id=N ────────────────────────────────────────────────

async function getKeyDetail(
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

    const keyRows = await executeQuery(
      connection,
      `SELECT ${KEY_COLUMNS}
       FROM dbo.Keys k
       JOIN dbo.Buildings b ON b.BuildingID = k.BuildingId
       LEFT JOIN dbo.Tenants t ON t.TenantID = k.TenancyId
       WHERE k.Id = @Id`,
      [{ name: "Id", type: TYPES.Int, value: id }],
    );
    if (keyRows.length === 0) return { status: 404, jsonBody: { error: "Key not found" } };

    const batchRows = await executeQuery(
      connection,
      `SELECT DISTINCT
         kb.Id AS BatchId, kb.CheckedOutBy, kb.CheckedOutTo,
         kb.CheckedOutAt, kb.ExpectedReturnAt, kb.CheckOutPhotoBlobUrl, kb.Notes,
         CASE WHEN EXISTS (
           SELECT 1 FROM dbo.KeyCheckouts kc2
           WHERE kc2.BatchId = kb.Id AND kc2.KeyId = @Id AND kc2.CheckedInAt IS NULL
         ) AND kb.ExpectedReturnAt < SYSUTCDATETIME()
         THEN 1 ELSE 0 END AS IsOverdue
       FROM dbo.KeyCheckoutBatches kb
       JOIN dbo.KeyCheckouts kco ON kco.BatchId = kb.Id AND kco.KeyId = @Id
       ORDER BY kb.CheckedOutAt DESC`,
      [{ name: "Id", type: TYPES.Int, value: id }],
    );

    const checkoutRows = await executeQuery(
      connection,
      `SELECT kco.Id, kco.BatchId, kco.KeyId, kco.CheckedInAt, kco.CheckInPhotoBlobUrl
       FROM dbo.KeyCheckouts kco
       JOIN dbo.KeyCheckoutBatches kb ON kb.Id = kco.BatchId
       WHERE kco.KeyId = @Id
       ORDER BY kb.CheckedOutAt DESC`,
      [{ name: "Id", type: TYPES.Int, value: id }],
    );

    const checkoutsByBatch = new Map<number, typeof checkoutRows>();
    for (const co of checkoutRows) {
      const bid = co.BatchId as number;
      if (!checkoutsByBatch.has(bid)) checkoutsByBatch.set(bid, []);
      checkoutsByBatch.get(bid)!.push(co);
    }

    const history = batchRows.map((row) => ({
      id: row.BatchId,
      checkedOutBy: row.CheckedOutBy,
      checkedOutTo: row.CheckedOutTo,
      checkedOutAt: row.CheckedOutAt,
      expectedReturnAt: row.ExpectedReturnAt,
      checkOutPhotoUrl: row.CheckOutPhotoBlobUrl
        ? generateReadSasUrl(row.CheckOutPhotoBlobUrl as string, 4 * 60 * 60 * 1000)
        : null,
      notes: row.Notes ?? null,
      isOverdue: row.IsOverdue === 1,
      checkouts: (checkoutsByBatch.get(row.BatchId as number) ?? []).map((co) => ({
        id: co.Id,
        batchId: co.BatchId,
        keyId: co.KeyId,
        checkedInAt: co.CheckedInAt ?? null,
        checkInPhotoUrl: co.CheckInPhotoBlobUrl
          ? generateReadSasUrl(co.CheckInPhotoBlobUrl as string, 4 * 60 * 60 * 1000)
          : null,
      })),
    }));

    const currentBatch = history.find((b) => b.checkouts.some((c) => c.checkedInAt === null)) ?? null;

    return {
      status: 200,
      jsonBody: { key: { ...formatKey(keyRows[0]), currentBatch, history } },
    };
  } catch (error: any) {
    context.error("getKeyDetail failed:", error.message);
    return errorResponse("Failed to fetch key detail", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/createKey ───────────────────────────────────────────────────────

async function createKey(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roleCheck = requireRole(request, EDIT_KEYS_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const body = (await request.json()) as any;
    const { BuildingId, TenancyId, Level, KeyNumber, ItemType, SubType,
            Registration, Description, PhotoBlobUrl, StorageLocation } = body ?? {};

    if (!BuildingId || !Level || !KeyNumber || !Description) {
      return { status: 400, jsonBody: { error: "BuildingId, Level, KeyNumber, Description required" } };
    }

    const caller = callerFromToken(token);
    connection = await createConnection(token);

    const inserted = await executeQuery(
      connection,
      `INSERT INTO dbo.Keys
         (BuildingId, TenancyId, Level, KeyNumber, ItemType, SubType,
          Registration, Description, PhotoBlobUrl, StorageLocation,
          CreatedById, CreatedByName)
       OUTPUT INSERTED.Id
       VALUES
         (@BuildingId, @TenancyId, @Level, @KeyNumber, @ItemType, @SubType,
          @Registration, @Description, @PhotoBlobUrl, @StorageLocation,
          @CreatedById, @CreatedByName)`,
      [
        { name: "BuildingId",      type: TYPES.Int,      value: BuildingId },
        { name: "TenancyId",       type: TYPES.Int,      value: TenancyId ?? null },
        { name: "Level",           type: TYPES.NVarChar,  value: Level },
        { name: "KeyNumber",       type: TYPES.NVarChar,  value: KeyNumber },
        { name: "ItemType",        type: TYPES.NVarChar,  value: ItemType ?? "key" },
        { name: "SubType",         type: TYPES.NVarChar,  value: SubType ?? null },
        { name: "Registration",    type: TYPES.NVarChar,  value: Registration ?? "standard" },
        { name: "Description",     type: TYPES.NVarChar,  value: Description },
        { name: "PhotoBlobUrl",    type: TYPES.NVarChar,  value: PhotoBlobUrl ?? null },
        { name: "StorageLocation", type: TYPES.NVarChar,  value: StorageLocation ?? null },
        { name: "CreatedById",     type: TYPES.NVarChar,  value: caller.id },
        { name: "CreatedByName",   type: TYPES.NVarChar,  value: caller.name },
      ],
    );

    const newId = inserted[0].Id as number;
    const rows = await executeQuery(
      connection,
      `SELECT ${KEY_COLUMNS}
       FROM dbo.Keys k
       JOIN dbo.Buildings b ON b.BuildingID = k.BuildingId
       LEFT JOIN dbo.Tenants t ON t.TenantID = k.TenancyId
       WHERE k.Id = @Id`,
      [{ name: "Id", type: TYPES.Int, value: newId }],
    );

    return { status: 200, jsonBody: { key: { ...formatKey(rows[0]), currentBatch: null } } };
  } catch (error: any) {
    if (error.message?.includes("UQ_Keys_Building_KeyNumber")) {
      return {
        status: 409,
        jsonBody: {
          error: "A key with that number already exists for this building.",
          code: "DUPLICATE_KEY_NUMBER",
        },
      };
    }
    context.error("createKey failed:", error.message);
    return errorResponse("Failed to create key", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── PUT /api/updateKey ────────────────────────────────────────────────────────

async function updateKey(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roleCheck = requireRole(request, EDIT_KEYS_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const body = (await request.json()) as any;
    const { Id, TenancyId, Level, SubType, Registration, Description,
            PhotoBlobUrl, StorageLocation } = body ?? {};

    if (!Id) return { status: 400, jsonBody: { error: "Id required" } };

    connection = await createConnection(token);
    await executeQuery(
      connection,
      `UPDATE dbo.Keys
       SET TenancyId = @TenancyId, Level = @Level, SubType = @SubType,
           Registration = @Registration, Description = @Description,
           PhotoBlobUrl = @PhotoBlobUrl, StorageLocation = @StorageLocation
       WHERE Id = @Id`,
      [
        { name: "Id",              type: TYPES.Int,      value: Id },
        { name: "TenancyId",       type: TYPES.Int,      value: TenancyId ?? null },
        { name: "Level",           type: TYPES.NVarChar,  value: Level },
        { name: "SubType",         type: TYPES.NVarChar,  value: SubType ?? null },
        { name: "Registration",    type: TYPES.NVarChar,  value: Registration ?? null },
        { name: "Description",     type: TYPES.NVarChar,  value: Description },
        { name: "PhotoBlobUrl",    type: TYPES.NVarChar,  value: PhotoBlobUrl ?? null },
        { name: "StorageLocation", type: TYPES.NVarChar,  value: StorageLocation ?? null },
      ],
    );

    const rows = await executeQuery(
      connection,
      `SELECT ${KEY_COLUMNS}
       FROM dbo.Keys k
       JOIN dbo.Buildings b ON b.BuildingID = k.BuildingId
       LEFT JOIN dbo.Tenants t ON t.TenantID = k.TenancyId
       WHERE k.Id = @Id`,
      [{ name: "Id", type: TYPES.Int, value: Id }],
    );
    return { status: 200, jsonBody: { key: { ...formatKey(rows[0]), currentBatch: null } } };
  } catch (error: any) {
    context.error("updateKey failed:", error.message);
    return errorResponse("Failed to update key", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/reportKeyLost ───────────────────────────────────────────────────

async function reportKeyLost(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roleCheck = requireRole(request, EDIT_KEYS_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const { Id, Comment } = ((await request.json()) as any) ?? {};
    if (!Id) return { status: 400, jsonBody: { error: "Id required" } };
    const trimmedComment = typeof Comment === "string" ? Comment.trim() : "";
    const lostComment = trimmedComment === "" ? null : trimmedComment;

    const caller = callerFromToken(token);
    connection = await createConnection(token);

    // Close any open checkout rows for this key
    await executeQuery(
      connection,
      `UPDATE dbo.KeyCheckouts
       SET CheckedInAt = SYSUTCDATETIME()
       WHERE KeyId = @Id AND CheckedInAt IS NULL`,
      [{ name: "Id", type: TYPES.Int, value: Id }],
    );

    await executeQuery(
      connection,
      `UPDATE dbo.Keys
       SET Status = 'lost',
           LostAt = SYSUTCDATETIME(),
           LostById = @LostById,
           LostByName = @LostByName,
           LostComment = @LostComment
       WHERE Id = @Id`,
      [
        { name: "Id",          type: TYPES.Int,      value: Id },
        { name: "LostById",    type: TYPES.NVarChar, value: caller.id },
        { name: "LostByName",  type: TYPES.NVarChar, value: caller.name },
        { name: "LostComment", type: TYPES.NVarChar, value: lostComment },
      ],
    );

    return { status: 200, jsonBody: { ok: true } };
  } catch (error: any) {
    context.error("reportKeyLost failed:", error.message);
    return errorResponse("Failed to report key lost", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/deleteKey ───────────────────────────────────────────────────────
// Soft delete. The row stays — it's hidden from /getKeys and rejected by
// /checkoutKeys, but /getKeyDetail still returns it so the UI can offer
// "Restore". Any open checkouts are force-closed so the audit trail closes
// cleanly. Mirrors the Jobs archive pattern from migration 041.

async function deleteKey(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roleCheck = requireRole(request, EDIT_KEYS_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const { Id } = ((await request.json()) as any) ?? {};
    if (!Id) return { status: 400, jsonBody: { error: "Id required" } };

    const caller = callerFromToken(token);
    connection = await createConnection(token);

    const existing = await executeQuery(
      connection,
      `SELECT IsDeleted FROM dbo.Keys WHERE Id = @Id`,
      [{ name: "Id", type: TYPES.Int, value: Id }],
    );
    if (existing.length === 0) {
      return { status: 404, jsonBody: { error: "Key not found", code: "KEY_NOT_FOUND" } };
    }
    if (existing[0].IsDeleted === true || existing[0].IsDeleted === 1) {
      return {
        status: 409,
        jsonBody: { error: "Key is already deleted.", code: "ALREADY_DELETED" },
      };
    }

    // Close any open checkout rows so the audit trail doesn't leave dangling
    // batches against a deleted key.
    await executeQuery(
      connection,
      `UPDATE dbo.KeyCheckouts
       SET CheckedInAt = SYSUTCDATETIME()
       WHERE KeyId = @Id AND CheckedInAt IS NULL`,
      [{ name: "Id", type: TYPES.Int, value: Id }],
    );

    await executeQuery(
      connection,
      `UPDATE dbo.Keys
       SET IsDeleted = 1,
           DeletedAt = SYSUTCDATETIME(),
           DeletedById = @DeletedById,
           DeletedByName = @DeletedByName
       WHERE Id = @Id`,
      [
        { name: "Id",            type: TYPES.Int,      value: Id },
        { name: "DeletedById",   type: TYPES.NVarChar, value: caller.id },
        { name: "DeletedByName", type: TYPES.NVarChar, value: caller.name },
      ],
    );

    return { status: 200, jsonBody: { ok: true } };
  } catch (error: any) {
    context.error("deleteKey failed:", error.message);
    return errorResponse("Failed to delete key", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/restoreKey ──────────────────────────────────────────────────────
// Reverses both "report lost" and "delete". Brings the key back to
// Status='active', IsDeleted=0. Used when a lost key turns up or a delete
// was made in error. Audit (CreatedBy) is preserved; we don't clear
// DeletedBy/At so the history of the deletion is still visible if anything
// wants to surface it later.

async function restoreKey(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roleCheck = requireRole(request, EDIT_KEYS_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const { Id } = ((await request.json()) as any) ?? {};
    if (!Id) return { status: 400, jsonBody: { error: "Id required" } };

    connection = await createConnection(token);

    const existing = await executeQuery(
      connection,
      `SELECT Status, IsDeleted FROM dbo.Keys WHERE Id = @Id`,
      [{ name: "Id", type: TYPES.Int, value: Id }],
    );
    if (existing.length === 0) {
      return { status: 404, jsonBody: { error: "Key not found", code: "KEY_NOT_FOUND" } };
    }
    const wasDeleted = existing[0].IsDeleted === true || existing[0].IsDeleted === 1;
    const wasLost = existing[0].Status === "lost";
    if (!wasDeleted && !wasLost) {
      return {
        status: 409,
        jsonBody: { error: "Key is already active — nothing to restore.", code: "ALREADY_ACTIVE" },
      };
    }

    await executeQuery(
      connection,
      `UPDATE dbo.Keys
       SET IsDeleted = 0, DeletedAt = NULL, Status = 'active'
       WHERE Id = @Id`,
      [{ name: "Id", type: TYPES.Int, value: Id }],
    );

    return { status: 200, jsonBody: { ok: true } };
  } catch (error: any) {
    context.error("restoreKey failed:", error.message);
    return errorResponse("Failed to restore key", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/checkoutKeys ────────────────────────────────────────────────────
// Body: { KeyIds, CheckedOutTo, ExpectedReturnAt, CheckOutPhotoBlobUrl, StorageLocation?, Notes? }
// CheckedOutBy is read from the JWT — not supplied by the caller.

async function checkoutKeys(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const { KeyIds, CheckedOutTo, ExpectedReturnAt, CheckOutPhotoBlobUrl,
            StorageLocation, Notes } = body ?? {};

    if (!Array.isArray(KeyIds) || KeyIds.length === 0) {
      return { status: 400, jsonBody: { error: "KeyIds (non-empty array) required" } };
    }
    if (!CheckedOutTo || !ExpectedReturnAt) {
      return { status: 400, jsonBody: { error: "CheckedOutTo, ExpectedReturnAt required" } };
    }
    // Photo is required when at least one item is a physical key. For codes
    // there's no handover, so it's optional.
    const photoBlob: string | null =
      typeof CheckOutPhotoBlobUrl === "string" && CheckOutPhotoBlobUrl.length > 0
        ? CheckOutPhotoBlobUrl
        : null;

    const checkedOutBy = callerFromToken(token).name;

    connection = await createConnection(token);

    const placeholders = KeyIds.map((_: number, i: number) => `@K${i}`).join(",");
    const params = KeyIds.map((id: number, i: number) => ({ name: `K${i}`, type: TYPES.Int, value: id }));

    // Validate every key exists, isn't soft-deleted, and is in `active` status.
    // Lost/retired/deleted keys can't be checked out — bail with a granular
    // error that names the offending keys so the UI can show a useful toast.
    const keyStateRows = await executeQuery(
      connection,
      `SELECT Id, KeyNumber, Status, IsDeleted FROM dbo.Keys WHERE Id IN (${placeholders})`,
      params,
    );
    if (keyStateRows.length !== KeyIds.length) {
      return {
        status: 404,
        jsonBody: { error: "One or more keys could not be found", code: "KEY_NOT_FOUND" },
      };
    }
    const deletedRows = keyStateRows.filter((r: any) => r.IsDeleted === true || r.IsDeleted === 1);
    if (deletedRows.length > 0) {
      const nums = deletedRows.map((r: any) => r.KeyNumber).join(", ");
      return {
        status: 409,
        jsonBody: { error: `Deleted — cannot check out: ${nums}`, code: "KEY_DELETED" },
      };
    }
    const inactiveRows = keyStateRows.filter((r: any) => r.Status !== "active");
    if (inactiveRows.length > 0) {
      const detail = inactiveRows
        .map((r: any) => `${r.KeyNumber} (${r.Status})`)
        .join(", ");
      return {
        status: 409,
        jsonBody: { error: `Not active — cannot check out: ${detail}`, code: "KEY_NOT_ACTIVE" },
      };
    }

    // Validate no physical key is already checked out. Codes are exempt — a
    // PIN/access code can be shared with multiple parties at the same time,
    // so re-sharing is always allowed.
    const alreadyOut = await executeQuery(
      connection,
      `SELECT k.Id, k.KeyNumber FROM dbo.Keys k
       JOIN dbo.KeyCheckouts kco ON kco.KeyId = k.Id AND kco.CheckedInAt IS NULL
       WHERE k.Id IN (${placeholders}) AND k.ItemType = 'key'`,
      params,
    );
    if (alreadyOut.length > 0) {
      const nums = alreadyOut.map((r: any) => r.KeyNumber).join(", ");
      return {
        status: 409,
        jsonBody: { error: `Already checked out: ${nums}`, code: "ALREADY_CHECKED_OUT" },
      };
    }

    // Photo is mandatory when at least one item being checked out is a
    // physical key. Codes alone are exempt — there's nothing to hand over.
    if (photoBlob === null) {
      const physicalRows = await executeQuery(
        connection,
        `SELECT 1 FROM dbo.Keys WHERE Id IN (${placeholders}) AND ItemType = 'key'`,
        params,
      );
      if (physicalRows.length > 0) {
        return {
          status: 400,
          jsonBody: {
            error: "A handover photo is required when checking out a physical key.",
            code: "PHOTO_REQUIRED",
          },
        };
      }
    }

    // Create batch
    const batchInserted = await executeQuery(
      connection,
      `INSERT INTO dbo.KeyCheckoutBatches
         (CheckedOutBy, CheckedOutTo, CheckedOutAt, ExpectedReturnAt, CheckOutPhotoBlobUrl, Notes)
       OUTPUT INSERTED.Id
       VALUES
         (@CheckedOutBy, @CheckedOutTo, SYSUTCDATETIME(), @ExpectedReturnAt, @Photo, @Notes)`,
      [
        { name: "CheckedOutBy",  type: TYPES.NVarChar, value: checkedOutBy },
        { name: "CheckedOutTo",  type: TYPES.NVarChar, value: CheckedOutTo },
        { name: "ExpectedReturnAt", type: TYPES.NVarChar, value: ExpectedReturnAt },
        { name: "Photo",         type: TYPES.NVarChar, value: photoBlob },
        { name: "Notes",         type: TYPES.NVarChar, value: Notes ?? null },
      ],
    );
    const batchId = batchInserted[0].Id as number;

    // Create one checkout row per key + update storage location
    for (let i = 0; i < KeyIds.length; i++) {
      const keyId = KeyIds[i] as number;
      await executeQuery(
        connection,
        `INSERT INTO dbo.KeyCheckouts (BatchId, KeyId) VALUES (@BatchId, @KeyId)`,
        [
          { name: "BatchId", type: TYPES.Int, value: batchId },
          { name: "KeyId",   type: TYPES.Int, value: keyId },
        ],
      );
      if (StorageLocation) {
        await executeQuery(
          connection,
          `UPDATE dbo.Keys SET StorageLocation = @Loc WHERE Id = @KeyId`,
          [
            { name: "Loc",   type: TYPES.NVarChar, value: StorageLocation },
            { name: "KeyId", type: TYPES.Int,      value: keyId },
          ],
        );
      }
    }

    return { status: 200, jsonBody: { batchId } };
  } catch (error: any) {
    context.error("checkoutKeys failed:", error.message);
    return errorResponse("Failed to checkout keys", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/checkinKeys ─────────────────────────────────────────────────────
// Body: { CheckoutIds, CheckInPhotoBlobUrl, StorageLocation? }
// Returns: { checkedIn: number[], remainingInBatches: { batchId, keyNumbers }[] }

async function checkinKeys(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const { CheckoutIds, CheckInPhotoBlobUrl, StorageLocation } = body ?? {};

    if (!Array.isArray(CheckoutIds) || CheckoutIds.length === 0) {
      return { status: 400, jsonBody: { error: "CheckoutIds (non-empty array) required" } };
    }
    if (!CheckInPhotoBlobUrl) {
      return { status: 400, jsonBody: { error: "CheckInPhotoBlobUrl required" } };
    }

    connection = await createConnection(token);

    const placeholders = CheckoutIds.map((_: number, i: number) => `@C${i}`).join(",");
    const params = CheckoutIds.map((id: number, i: number) => ({ name: `C${i}`, type: TYPES.Int, value: id }));

    // Mark checked in
    await executeQuery(
      connection,
      `UPDATE dbo.KeyCheckouts
       SET CheckedInAt = SYSUTCDATETIME(), CheckInPhotoBlobUrl = @Photo
       WHERE Id IN (${placeholders}) AND CheckedInAt IS NULL`,
      [{ name: "Photo", type: TYPES.NVarChar, value: CheckInPhotoBlobUrl }, ...params],
    );

    // Get key IDs for storage location update
    if (StorageLocation) {
      const coRows = await executeQuery(
        connection,
        `SELECT KeyId FROM dbo.KeyCheckouts WHERE Id IN (${placeholders})`,
        params,
      );
      for (const row of coRows) {
        await executeQuery(
          connection,
          `UPDATE dbo.Keys SET StorageLocation = @Loc WHERE Id = @KeyId`,
          [
            { name: "Loc",   type: TYPES.NVarChar, value: StorageLocation },
            { name: "KeyId", type: TYPES.Int,      value: row.KeyId },
          ],
        );
      }
    }

    // Detect incomplete batches after this check-in
    const affectedBatches = await executeQuery(
      connection,
      `SELECT DISTINCT kco.BatchId FROM dbo.KeyCheckouts kco WHERE kco.Id IN (${placeholders})`,
      params,
    );
    const batchIds = affectedBatches.map((r: any) => r.BatchId as number);

    const remainingInBatches: { batchId: number; keyNumbers: string[] }[] = [];
    for (const batchId of batchIds) {
      const remaining = await executeQuery(
        connection,
        `SELECT k.KeyNumber FROM dbo.KeyCheckouts kco
         JOIN dbo.Keys k ON k.Id = kco.KeyId
         WHERE kco.BatchId = @BatchId AND kco.CheckedInAt IS NULL`,
        [{ name: "BatchId", type: TYPES.Int, value: batchId }],
      );
      if (remaining.length > 0) {
        remainingInBatches.push({
          batchId,
          keyNumbers: remaining.map((r: any) => r.KeyNumber as string),
        });
      }
    }

    return {
      status: 200,
      jsonBody: { checkedIn: CheckoutIds, remainingInBatches },
    };
  } catch (error: any) {
    context.error("checkinKeys failed:", error.message);
    return errorResponse("Failed to check in keys", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/uploadKeyPhoto ──────────────────────────────────────────────────
// Accepts multipart/form-data with a 'photo' field (image file).
// Returns: { blobName, url }

async function uploadKeyPhoto(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  try {
    const formData = await request.formData();
    const file = formData.get("photo") as File | null;
    if (!file) return { status: 400, jsonBody: { error: "'photo' field required" } };

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await uploadBlob(buffer, file.name, file.type || "image/jpeg", "keys");
    const url = generateReadSasUrl(result.blobName, 7 * 24 * 60 * 60 * 1000); // 7-day SAS for photo preview
    return { status: 200, jsonBody: { blobName: result.blobName, url } };
  } catch (error: any) {
    context.error("uploadKeyPhoto failed:", error.message);
    return errorResponse("Failed to upload photo", error.message);
  }
}

// ── GET /api/keyImportTemplate ────────────────────────────────────────────────
// Downloads a pre-built XLSX template with building dropdown validation.

async function keyImportTemplate(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    connection = await createConnection(token);
    const buildings = await executeQuery(
      connection,
      `SELECT BuildingName FROM dbo.Buildings WHERE Active = 1 ORDER BY BuildingName`,
      [],
    );
    const buildingNames = buildings.map((b: any) => b.BuildingName as string);

    // All subtypes combined — Item Type determines which apply, but XLSX
    // can't do conditional validation without VBA, so we show the full set.
    const allSubTypes = [...KEY_SUB_TYPES, ...CODE_SUB_TYPES];
    const storageLocations = [...KEY_STORAGE_LOCATIONS];

    const wb = new ExcelJS.Workbook();

    // Keys sheet — first = active on open
    const headers = [
      "Item Type", "Building", "Key Number", "Level",
      "Description", "Sub Type", "Tenancy Name", "Registration", "Storage Location",
    ];
    const keysWs = wb.addWorksheet("Keys");
    keysWs.columns = headers.map((h) => ({ header: h, key: h, width: 24 }));

    // dataValidations exists at runtime but is absent from the exceljs 4.x type declarations
    const dvs = (keysWs as any).dataValidations;
    dvs.add("A2:A1000", { type: "list", allowBlank: true, formulae: ['"key,code"'] });
    dvs.add("B2:B1000", { type: "list", allowBlank: true, formulae: [`_Buildings!$A$1:$A$${buildingNames.length || 1}`] });
    dvs.add("F2:F1000", { type: "list", allowBlank: true, formulae: [`_SubTypes!$A$1:$A$${allSubTypes.length}`] });
    dvs.add("H2:H1000", { type: "list", allowBlank: true, formulae: ['"standard,registered"'] });
    dvs.add("I2:I1000", { type: "list", allowBlank: true, formulae: [`_StorageLocations!$A$1:$A$${storageLocations.length}`] });

    // Info sheet — visible reference for valid values
    const infoWs = wb.addWorksheet("Info");
    const infoData: (string | null)[][] = [
      ["Field", "Valid Values"],
      ["Item Type", ITEM_TYPES.join(", ")],
      ["Registration", REGISTRATIONS.join(", ")],
      ["Sub Type (keys)", KEY_SUB_TYPES.join(", ")],
      ["Sub Type (codes)", CODE_SUB_TYPES.join(", ")],
      [null, null],
      ["Storage Location", null],
      ...storageLocations.map((loc) => [null, loc]),
      [null, null],
      ["Notes", null],
      [null, "• Building must match exactly (use the dropdown in the Keys sheet)"],
      [null, "• Tenancy Name is optional — leave blank if not applicable"],
      [null, "• Key Number must be unique per building"],
      [null, "• Sub Type and Storage Location are optional for codes"],
    ];
    infoData.forEach((row) => infoWs.addRow(row));
    infoWs.getColumn(1).width = 22;
    infoWs.getColumn(2).width = 80;

    // Hidden reference sheets for dropdown formulae
    const buildingsWs = wb.addWorksheet("_Buildings", { state: "veryHidden" });
    buildingNames.forEach((n) => buildingsWs.addRow([n]));

    const subTypesWs = wb.addWorksheet("_SubTypes", { state: "veryHidden" });
    allSubTypes.forEach((n) => subTypesWs.addRow([n]));

    const storageWs = wb.addWorksheet("_StorageLocations", { state: "veryHidden" });
    storageLocations.forEach((n) => storageWs.addRow([n]));

    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    return {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="keys-import-template.xlsx"',
      },
      body: buf,
    };
  } catch (error: any) {
    context.error("keyImportTemplate failed:", error.message);
    return errorResponse("Failed to generate template", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/bulkImportKeys ──────────────────────────────────────────────────
// Role-restricted: Admin or timesheet_approval_facilities only.
// Accepts multipart/form-data with an 'file' field (XLSX).

async function bulkImportKeys(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roleCheck = requireRole(request, BULK_CREATE_ROLES);
  if (roleCheck) return roleCheck;

  const caller = callerFromToken(token);

  let connection;
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    if (!file) return { status: 400, jsonBody: { error: "'file' field required" } };

    const buffer = Buffer.from(await file.arrayBuffer());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    // Use "Keys" sheet by name — don't rely on index since the template has hidden reference sheets
    const ws = wb.getWorksheet("Keys") ??
      wb.worksheets.find((s) => !s.name.startsWith("_")) ??
      wb.worksheets[0];
    if (!ws) return { status: 400, jsonBody: { error: "No readable sheet found in uploaded file" } };

    // Build header→column index map from row 1
    const headerMap = new Map<string, number>();
    ws.getRow(1).eachCell((cell, colNum) => {
      const h = String(cell.value ?? "").trim();
      if (h) headerMap.set(h, colNum);
    });

    // Extract data rows — cells coerced to string matching sheet_to_json({ raw: false }) behaviour
    const allRows: Record<string, string>[] = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const r: Record<string, string> = {};
      headerMap.forEach((colNum, header) => {
        r[header] = String(row.getCell(colNum).value ?? "").trim();
      });
      allRows.push(r);
    });
    // Skip trailing blank rows
    const rows = allRows.filter((r) => (r["Item Type"] ?? "").trim() !== "" || (r["Building"] ?? "").trim() !== "");

    connection = await createConnection(token);

    // Load buildings for name→id lookup. The Keys FK references Buildings.BuildingID
    // (not Id), so we must read that column or every insert violates FK_Keys_Buildings_BuildingID.
    const buildings = await executeQuery(
      connection,
      `SELECT BuildingID, BuildingName FROM dbo.Buildings`,
      [],
    );
    const buildingMap = new Map<string, number>(
      buildings.map((b: any) => [String(b.BuildingName).toLowerCase().trim(), b.BuildingID as number]),
    );

    // Load tenancies for name→id lookup
    const tenancies = await executeQuery(connection, `SELECT TenantId AS Id, LegalName AS Name FROM dbo.Tenants`, []);
    const tenancyMap = new Map<string, number>(
      tenancies.map((t: any) => [String(t.Name).toLowerCase().trim(), t.Id as number]),
    );

    const created: number[] = [];
    const duplicatesSkipped: { keyNumber: string; buildingName: string }[] = [];
    const errors: { row: number; reason: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rowNum = i + 2; // 1-indexed, header is row 1
      const buildingName = (r["Building"] ?? "").trim();
      const keyNumber = (r["Key Number"] ?? "").trim();
      const level = (r["Level"] ?? "").trim();
      const description = (r["Description"] ?? "").trim();
      const itemType = (r["Item Type"] ?? "key").trim().toLowerCase() || "key";

      if (!buildingName || !keyNumber || !level || !description) {
        errors.push({ row: rowNum, reason: "Building, Key Number, Level, and Description are required" });
        continue;
      }

      if (!(ITEM_TYPES as readonly string[]).includes(itemType)) {
        errors.push({ row: rowNum, reason: `Item Type "${itemType}" must be one of: ${ITEM_TYPES.join(", ")}` });
        continue;
      }

      const buildingId = buildingMap.get(buildingName.toLowerCase().trim());
      if (!buildingId) {
        errors.push({ row: rowNum, reason: `Building "${buildingName}" not found` });
        continue;
      }

      const tenancyName = (r["Tenancy Name"] ?? "").trim();
      const tenancyId = tenancyName ? (tenancyMap.get(tenancyName.toLowerCase().trim()) ?? null) : null;

      const subType = (r["Sub Type"] ?? "").trim() || null;
      const registration = (r["Registration"] ?? "standard").trim().toLowerCase() || "standard";
      const storageLocation = (r["Storage Location"] ?? "").trim() || null;

      if (!(REGISTRATIONS as readonly string[]).includes(registration)) {
        errors.push({ row: rowNum, reason: `Registration "${registration}" must be one of: ${REGISTRATIONS.join(", ")}` });
        continue;
      }

      if (subType) {
        const allowedSubTypes = itemType === "code" ? CODE_SUB_TYPES : KEY_SUB_TYPES;
        if (!(allowedSubTypes as readonly string[]).includes(subType)) {
          errors.push({ row: rowNum, reason: `Sub Type "${subType}" is not valid for item type "${itemType}"` });
          continue;
        }
      }

      // Validate storage location if provided
      if (storageLocation && !(KEY_STORAGE_LOCATIONS as readonly string[]).includes(storageLocation)) {
        errors.push({ row: rowNum, reason: `Storage location "${storageLocation}" is not a known location` });
        continue;
      }

      try {
        await executeQuery(
          connection,
          `INSERT INTO dbo.Keys
             (BuildingId, TenancyId, Level, KeyNumber, ItemType, SubType,
              Registration, Description, StorageLocation,
              CreatedById, CreatedByName)
           VALUES
             (@BuildingId, @TenancyId, @Level, @KeyNumber, @ItemType, @SubType,
              @Registration, @Description, @StorageLocation,
              @CreatedById, @CreatedByName)`,
          [
            { name: "BuildingId",      type: TYPES.Int,      value: buildingId },
            { name: "TenancyId",       type: TYPES.Int,      value: tenancyId },
            { name: "Level",           type: TYPES.NVarChar,  value: level },
            { name: "KeyNumber",       type: TYPES.NVarChar,  value: keyNumber },
            { name: "ItemType",        type: TYPES.NVarChar,  value: itemType },
            { name: "SubType",         type: TYPES.NVarChar,  value: subType },
            { name: "Registration",    type: TYPES.NVarChar,  value: registration },
            { name: "Description",     type: TYPES.NVarChar,  value: description },
            { name: "StorageLocation", type: TYPES.NVarChar,  value: storageLocation },
            { name: "CreatedById",     type: TYPES.NVarChar,  value: caller.id },
            { name: "CreatedByName",   type: TYPES.NVarChar,  value: caller.name },
          ],
        );
        created.push(rowNum);
      } catch (err: any) {
        if (err.message?.includes("UQ_Keys_Building_KeyNumber")) {
          duplicatesSkipped.push({ keyNumber, buildingName });
        } else {
          errors.push({ row: rowNum, reason: err.message });
        }
      }
    }

    return {
      status: 200,
      jsonBody: { created: created.length, duplicatesSkipped, errors },
    };
  } catch (error: any) {
    context.error("bulkImportKeys failed:", error.message);
    return errorResponse("Failed to import keys", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── Route registration ────────────────────────────────────────────────────────

app.http("getKeys",            { methods: ["GET"],  authLevel: "anonymous", handler: getKeys });
app.http("getKeyDetail",       { methods: ["GET"],  authLevel: "anonymous", handler: getKeyDetail });
app.http("createKey",          { methods: ["POST"], authLevel: "anonymous", handler: createKey });
app.http("updateKey",          { methods: ["PUT"],  authLevel: "anonymous", handler: updateKey });
app.http("reportKeyLost",      { methods: ["POST"], authLevel: "anonymous", handler: reportKeyLost });
app.http("deleteKey",          { methods: ["POST"], authLevel: "anonymous", handler: deleteKey });
app.http("restoreKey",         { methods: ["POST"], authLevel: "anonymous", handler: restoreKey });
app.http("checkoutKeys",       { methods: ["POST"], authLevel: "anonymous", handler: checkoutKeys });
app.http("checkinKeys",        { methods: ["POST"], authLevel: "anonymous", handler: checkinKeys });
app.http("uploadKeyPhoto",     { methods: ["POST"], authLevel: "anonymous", handler: uploadKeyPhoto });
app.http("keyImportTemplate",  { methods: ["GET"],  authLevel: "anonymous", handler: keyImportTemplate });
app.http("bulkImportKeys",     { methods: ["POST"], authLevel: "anonymous", handler: bulkImportKeys });
