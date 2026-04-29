// Keys — CRUD for key/code registrations, batch checkout, and check-in.
// Photos are uploaded via uploadKeyPhoto before the checkout/checkin payload
// is submitted; callers include the returned URL in their request body.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import * as XLSX from "xlsx";
import { TYPES } from "tedious";
import { createConnection, createServiceConnection, executeQuery, closeConnection } from "../db";
import {
  extractToken,
  unauthorizedResponse,
  errorResponse,
  requireRole,
  rolesForRequest,
} from "../auth";
import { uploadBlob, generateReadSasUrl } from "../blob-storage";

const BULK_CREATE_ROLES = ["Admin", "timesheet_approval_facilities"] as const;

const KEY_STORAGE_LOCATIONS = [
  "Randazzo Properties Office",
  "Randazzo Center (Harry Potter Room)",
  "9 Cavanagh (Plant Room)",
  "66 Smith (Plant Room)",
  "Bov Plaza (Site Office)",
] as const;

// ── Notification stub ────────────────────────────────────────────────────────
// TODO: send Graph API email to key manager when key is overdue
async function notifyOverdueKey(_keyId: number): Promise<void> {
  return;
}

// ── Column helpers ───────────────────────────────────────────────────────────

const KEY_COLUMNS = `
  k.Id, k.BuildingId, b.BuildingName,
  k.TenancyId, t.TenantName AS TenancyName,
  k.Level, k.KeyNumber, k.ItemType, k.SubType, k.Registration,
  k.Description, k.PhotoBlobUrl, k.StorageLocation,
  k.DateAdded, k.Status
`;

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
      ? generateReadSasUrl(row.PhotoBlobUrl as string, 4 * 60 * 60 * 1000)
      : null,
    storageLocation: row.StorageLocation ?? null,
    dateAdded: row.DateAdded,
    status: row.Status,
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

    const rows = await executeQuery(
      connection,
      `SELECT
         ${KEY_COLUMNS},
         kb.Id      AS BatchId,
         kb.CheckedOutBy, kb.CheckedOutTo,
         kb.CheckedOutAt, kb.ExpectedReturnAt,
         kb.CheckOutPhotoBlobUrl, kb.Notes,
         CASE WHEN (
           SELECT COUNT(*) FROM dbo.KeyCheckouts kc2
           WHERE kc2.BatchId = kb.Id AND kc2.KeyId = k.Id AND kc2.CheckedInAt IS NULL
         ) > 0 AND kb.ExpectedReturnAt < SYSUTCDATETIME()
         THEN 1 ELSE 0 END AS IsOverdue
       FROM dbo.Keys k
       JOIN dbo.Buildings b ON b.BuildingID = k.BuildingId
       LEFT JOIN dbo.Tenants t ON t.TenantID = k.TenancyId
       LEFT JOIN dbo.KeyCheckouts kco
         ON kco.KeyId = k.Id AND kco.CheckedInAt IS NULL
       LEFT JOIN dbo.KeyCheckoutBatches kb ON kb.Id = kco.BatchId
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

  let connection;
  try {
    const body = (await request.json()) as any;
    const { BuildingId, TenancyId, Level, KeyNumber, ItemType, SubType,
            Registration, Description, PhotoBlobUrl, StorageLocation } = body ?? {};

    if (!BuildingId || !Level || !KeyNumber || !Description) {
      return { status: 400, jsonBody: { error: "BuildingId, Level, KeyNumber, Description required" } };
    }

    connection = await createConnection(token);

    const inserted = await executeQuery(
      connection,
      `INSERT INTO dbo.Keys
         (BuildingId, TenancyId, Level, KeyNumber, ItemType, SubType,
          Registration, Description, PhotoBlobUrl, StorageLocation)
       OUTPUT INSERTED.Id
       VALUES
         (@BuildingId, @TenancyId, @Level, @KeyNumber, @ItemType, @SubType,
          @Registration, @Description, @PhotoBlobUrl, @StorageLocation)`,
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
      return { status: 409, jsonBody: { error: "A key with that number already exists for this building." } };
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

  let connection;
  try {
    const { Id } = ((await request.json()) as any) ?? {};
    if (!Id) return { status: 400, jsonBody: { error: "Id required" } };

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
      `UPDATE dbo.Keys SET Status = 'lost' WHERE Id = @Id`,
      [{ name: "Id", type: TYPES.Int, value: Id }],
    );

    return { status: 200, jsonBody: { ok: true } };
  } catch (error: any) {
    context.error("reportKeyLost failed:", error.message);
    return errorResponse("Failed to report key lost", error.message);
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

    // Decode name from the JWT
    const payload = token.split(".")[1];
    const decoded = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(payload.length + ((4 - payload.length % 4) % 4), "="), "base64").toString("utf8")) as any;
    const checkedOutBy: string = decoded?.name ?? decoded?.preferred_username ?? "Unknown";

    connection = await createConnection(token);

    // Validate no key is already checked out
    const placeholders = KeyIds.map((_: number, i: number) => `@K${i}`).join(",");
    const params = KeyIds.map((id: number, i: number) => ({ name: `K${i}`, type: TYPES.Int, value: id }));

    const alreadyOut = await executeQuery(
      connection,
      `SELECT k.Id, k.KeyNumber FROM dbo.Keys k
       JOIN dbo.KeyCheckouts kco ON kco.KeyId = k.Id AND kco.CheckedInAt IS NULL
       WHERE k.Id IN (${placeholders})`,
      params,
    );
    if (alreadyOut.length > 0) {
      const nums = alreadyOut.map((r: any) => r.KeyNumber).join(", ");
      return { status: 409, jsonBody: { error: `Already checked out: ${nums}` } };
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
          jsonBody: { error: "CheckOutPhotoBlobUrl required when checking out a physical key" },
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
  _request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  let connection;
  try {
    connection = await createServiceConnection();
    const buildings = await executeQuery(
      connection,
      `SELECT BuildingName FROM dbo.Buildings WHERE Active = 1 ORDER BY BuildingName`,
      [],
    );
    const buildingNames = buildings.map((b: any) => b.BuildingName as string);

    // All subtypes combined — Item Type determines which apply, but XLSX
    // can't do conditional validation without VBA, so we show the full set.
    const allSubTypes = [
      "Normal", "BiLock", "Dimpled", "Safe", "Laser Tracked", "Cylinder",
      "Tubular", "Window", "Fob (RFID)", "Keycard", "Padlock", "ABLOY", "Lockwood",
      "Door Code", "Mechanical Code Lock", "Electronic Keypad", "Smart Lock", "Padlock/Chain",
    ];

    const storageLocations = [
      "Randazzo Properties Office",
      "Randazzo Center (Harry Potter Room)",
      "9 Cavanagh (Plant Room)",
      "66 Smith (Plant Room)",
      "Bov Plaza (Site Office)",
    ];

    const wb = XLSX.utils.book_new();
    const headers = [
      "Item Type", "Building", "Key Number", "Level",
      "Description", "Sub Type", "Tenancy Name", "Registration", "Storage Location",
    ];
    const ws = XLSX.utils.aoa_to_sheet([headers]);

    // Column widths
    ws["!cols"] = headers.map(() => ({ wch: 24 }));

    // Hidden reference sheets for long dropdown lists
    const buildingsWs = XLSX.utils.aoa_to_sheet(buildingNames.map((n) => [n]));
    const subTypesWs = XLSX.utils.aoa_to_sheet(allSubTypes.map((n) => [n]));
    const storageWs = XLSX.utils.aoa_to_sheet(storageLocations.map((n) => [n]));

    // Visible reference sheet showing valid values for every enum field
    const infoData: (string | null)[][] = [
      ["Field", "Valid Values"],
      ["Item Type", "key, code"],
      ["Registration", "standard, registered"],
      ["Sub Type (keys)", "Normal, BiLock, Dimpled, Safe, Laser Tracked, Cylinder, Tubular, Window, Fob (RFID), Keycard, Padlock, ABLOY, Lockwood"],
      ["Sub Type (codes)", "Door Code, Mechanical Code Lock, Electronic Keypad, Smart Lock, Padlock/Chain"],
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
    const infoWs = XLSX.utils.aoa_to_sheet(infoData);
    infoWs["!cols"] = [{ wch: 22 }, { wch: 80 }];

    // Keys sheet is first (active on open), Info sheet second, reference sheets follow
    XLSX.utils.book_append_sheet(wb, ws, "Keys");
    XLSX.utils.book_append_sheet(wb, infoWs, "Info");
    XLSX.utils.book_append_sheet(wb, buildingsWs, "_Buildings");
    XLSX.utils.book_append_sheet(wb, subTypesWs, "_SubTypes");
    XLSX.utils.book_append_sheet(wb, storageWs, "_StorageLocations");

    ws["!dataValidations"] = [
      // A: Item Type
      {
        type: "list" as const,
        formula1: '"key,code"',
        showDropDown: false,
        sqref: "A2:A1000",
      },
      // B: Building
      {
        type: "list" as const,
        formula1: `_Buildings!$A$1:$A$${buildingNames.length || 1}`,
        showDropDown: false,
        sqref: "B2:B1000",
      },
      // F: Sub Type
      {
        type: "list" as const,
        formula1: `_SubTypes!$A$1:$A$${allSubTypes.length}`,
        showDropDown: false,
        sqref: "F2:F1000",
      },
      // H: Registration
      {
        type: "list" as const,
        formula1: '"standard,registered"',
        showDropDown: false,
        sqref: "H2:H1000",
      },
      // I: Storage Location
      {
        type: "list" as const,
        formula1: `_StorageLocations!$A$1:$A$${storageLocations.length}`,
        showDropDown: false,
        sqref: "I2:I1000",
      },
    ];

    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

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

  let connection;
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    if (!file) return { status: 400, jsonBody: { error: "'file' field required" } };

    const buffer = Buffer.from(await file.arrayBuffer());
    const wb = XLSX.read(buffer, { type: "buffer" });
    // Use "Keys" sheet by name — don't rely on index since the template has hidden reference sheets
    const ws = wb.Sheets["Keys"] ?? wb.Sheets[wb.SheetNames.find((n) => !n.startsWith("_")) ?? wb.SheetNames[0]];
    const allRows = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: "", raw: false });
    // Skip rows where the first cell (Item Type) is empty — catches trailing blank rows in the template
    const rows = allRows.filter((r) => (r["Item Type"] ?? "").trim() !== "" || (r["Building"] ?? "").trim() !== "");

    connection = await createConnection(token);

    // Load buildings for name→id lookup
    const buildings = await executeQuery(connection, `SELECT Id, BuildingName FROM dbo.Buildings`, []);
    const buildingMap = new Map<string, number>(
      buildings.map((b: any) => [String(b.BuildingName).toLowerCase().trim(), b.Id as number]),
    );

    // Load tenancies for name→id lookup
    const tenancies = await executeQuery(connection, `SELECT TenantID AS Id, TenantName AS Name FROM dbo.Tenants`, []);
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
              Registration, Description, StorageLocation)
           VALUES
             (@BuildingId, @TenancyId, @Level, @KeyNumber, @ItemType, @SubType,
              @Registration, @Description, @StorageLocation)`,
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
app.http("checkoutKeys",       { methods: ["POST"], authLevel: "anonymous", handler: checkoutKeys });
app.http("checkinKeys",        { methods: ["POST"], authLevel: "anonymous", handler: checkinKeys });
app.http("uploadKeyPhoto",     { methods: ["POST"], authLevel: "anonymous", handler: uploadKeyPhoto });
app.http("keyImportTemplate",  { methods: ["GET"],  authLevel: "anonymous", handler: keyImportTemplate });
app.http("bulkImportKeys",     { methods: ["POST"], authLevel: "anonymous", handler: bulkImportKeys });
