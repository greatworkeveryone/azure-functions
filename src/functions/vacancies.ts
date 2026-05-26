// azure-functions/src/functions/vacancies.ts

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { closeConnection, createConnection, executeQuery, SqlRow } from "../db";
import { AppRole, extractToken, errorResponse, requireRole, unauthorizedResponse } from "../auth";
import { uploadPublicBlob, deletePublicBlob } from "../blob-storage";
import { MAX_SIZE_BYTES } from "../upload-constants";
import { buildWpPayload } from "../wpContentBuilder";

const IMAGE_CONTENT_TYPES = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif",
]);

const GALLERY_SLOT_LABELS = ["Main Room", "Office 1", "Office 2"] as const;

const VACANCY_ROLES = [
  AppRole.ADMIN,
  AppRole.DIRECTOR,
  AppRole.FACILITIES,
  AppRole.FACILITIES_APPROVAL,
  AppRole.ACCOUNTS,
  AppRole.ACCOUNTS_APPROVAL,
] as const;

function rowToVacancy(row: SqlRow): Record<string, unknown> {
  return {
    id: row.Id,
    title: row.Title,
    buildingId: row.BuildingId ?? null,
    buildingHeroImageUrl: (row.HeroImageUrl as string | null) ?? null,
    address: row.Address ?? null,
    description: row.Description ?? null,
    additionalDetails: JSON.parse((row.AdditionalDetails as string) ?? "[]"),
    images: JSON.parse((row.Images as string) ?? "[]"),
    slotImages: JSON.parse((row.SlotImages as string) ?? "{}"),
    status: row.Status,
    wordpressPostId: row.WordPressPostId ?? null,
    wordpressSlug: row.WordPressSlug ?? null,
    lastSyncedAt: row.LastSyncedAt ?? null,
    tenancyId: row.TenancyId ?? null,
    createdAt: row.CreatedAt,
    updatedAt: row.UpdatedAt,
  };
}

async function fetchVacancyRow(
  connection: Awaited<ReturnType<typeof createConnection>>,
  vacancyId: number,
): Promise<SqlRow | null> {
  const rows = await executeQuery(
    connection,
    `SELECT v.*, b.HeroImageUrl
     FROM dbo.Vacancies v
     LEFT JOIN dbo.Buildings b ON b.BuildingID = v.BuildingId
     WHERE v.Id = @Id`,
    [{ name: "Id", type: TYPES.Int, value: vacancyId }],
  );
  return rows[0] ?? null;
}

function rowToVacancySummary(row: SqlRow): Record<string, unknown> {
  const images: string[] = JSON.parse((row.Images as string) ?? "[]");
  const heroImageUrl = (row.HeroImageUrl as string | null) ?? null;
  return {
    id: row.Id,
    title: row.Title,
    address: row.Address ?? null,
    buildingId: row.BuildingId ?? null,
    buildingName: row.BuildingName ?? null,
    buildingHeroImageUrl: heroImageUrl,
    status: row.Status,
    firstImageUrl: images[0] ?? heroImageUrl,
    lastSyncedAt: row.LastSyncedAt ?? null,
    tenancyId: row.TenancyId ?? null,
  };
}

// ── GET /api/getVacancies ────────────────────────────────────────────────────

async function handleGetVacancies(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = requireRole(request, VACANCY_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    connection = await createConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT v.Id, v.Title, v.Address, v.Status, v.Images, v.LastSyncedAt, v.TenancyId,
              v.BuildingId, b.BuildingName, b.HeroImageUrl
       FROM dbo.Vacancies v
       LEFT JOIN dbo.Buildings b ON b.BuildingID = v.BuildingId
       ORDER BY v.CreatedAt DESC`,
      [],
    );
    return { jsonBody: { vacancies: rows.map(rowToVacancySummary) } };
  } catch (error: any) {
    return errorResponse("Failed to fetch vacancies", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getVacancies", {
  authLevel: "anonymous",
  handler: handleGetVacancies,
  methods: ["GET"],
});

// ── GET /api/getVacantTenancies ──────────────────────────────────────────────

async function handleGetVacantTenancies(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = requireRole(request, VACANCY_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    connection = await createConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT t.TenantId, t.LegalName, t.BuildingId, b.BuildingName,
              o.OccupancyId, o.Level, o.Area, o.SizeSqm
       FROM dbo.Tenants t
       INNER JOIN dbo.Buildings b ON b.BuildingID = t.BuildingId
       LEFT JOIN dbo.TenantOccupancies o ON o.TenantId = t.TenantId
       WHERE t.Status = 'vacated'
       ORDER BY b.BuildingName, t.TenantId, o.Level, o.Area`,
      [],
    );

    // Group occupancy rows by tenant.
    const byTenant = new Map<number, {
      tenantId: number;
      legalName: string;
      buildingId: number;
      buildingName: string;
      occupancies: Array<{ occupancyId: string; level: string; area: string; sizeSqm: number }>;
    }>();

    for (const row of rows) {
      const tenantId = row.TenantId as number;
      if (!byTenant.has(tenantId)) {
        byTenant.set(tenantId, {
          tenantId,
          legalName: row.LegalName as string,
          buildingId: row.BuildingId as number,
          buildingName: row.BuildingName as string,
          occupancies: [],
        });
      }
      if (row.OccupancyId) {
        byTenant.get(tenantId)!.occupancies.push({
          occupancyId: row.OccupancyId as string,
          level: row.Level as string,
          area: row.Area as string,
          sizeSqm: Number(row.SizeSqm),
        });
      }
    }

    return { jsonBody: { tenancies: Array.from(byTenant.values()) } };
  } catch (error: any) {
    return errorResponse("Failed to fetch vacant tenancies", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getVacantTenancies", {
  authLevel: "anonymous",
  handler: handleGetVacantTenancies,
  methods: ["GET"],
});

// ── POST /api/createVacancy ──────────────────────────────────────────────────

async function handleCreateVacancy(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = requireRole(request, VACANCY_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const body = (await request.json()) as {
      tenancyId?: number;
      buildingId?: number;
      title?: string;
    };
    const tenancyId = typeof body.tenancyId === "number" ? body.tenancyId : null;
    const buildingId = typeof body.buildingId === "number" ? body.buildingId : null;
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "New vacancy";

    connection = await createConnection(token);

    const inserted = await executeQuery(
      connection,
      `INSERT INTO dbo.Vacancies (Title, Status, AdditionalDetails, Images, TenancyId, BuildingId)
       OUTPUT INSERTED.*
       VALUES (@Title, 'draft', '[]', '[]', @TenancyId, @BuildingId)`,
      [
        { name: "Title", type: TYPES.NVarChar, value: title },
        { name: "TenancyId", type: TYPES.Int, value: tenancyId },
        { name: "BuildingId", type: TYPES.Int, value: buildingId },
      ],
    );

    return { status: 201, jsonBody: { vacancy: rowToVacancy(inserted[0]) } };
  } catch (error: any) {
    return errorResponse("Failed to create vacancy", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("createVacancy", {
  authLevel: "anonymous",
  handler: handleCreateVacancy,
  methods: ["POST"],
});

// ── GET /api/getVacancy ──────────────────────────────────────────────────────

async function handleGetVacancy(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = requireRole(request, VACANCY_ROLES);
  if (roleCheck) return roleCheck;

  const id = Number(request.query.get("id"));
  if (!Number.isFinite(id)) {
    return { status: 400, jsonBody: { error: "Missing or invalid 'id' param" } };
  }

  let connection;
  try {
    connection = await createConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT v.*, b.HeroImageUrl
       FROM dbo.Vacancies v
       LEFT JOIN dbo.Buildings b ON b.BuildingID = v.BuildingId
       WHERE v.Id = @Id`,
      [{ name: "Id", type: TYPES.Int, value: id }],
    );
    if (!rows[0]) return { status: 404, jsonBody: { error: "Not found" } };
    return { jsonBody: { vacancy: rowToVacancy(rows[0]) } };
  } catch (error: any) {
    return errorResponse("Failed to fetch vacancy", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getVacancy", {
  authLevel: "anonymous",
  handler: handleGetVacancy,
  methods: ["GET"],
});

// ── PUT /api/updateVacancy ───────────────────────────────────────────────────

async function handleUpdateVacancy(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = requireRole(request, VACANCY_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const body = (await request.json()) as {
      id: number;
      title?: string;
      buildingId?: number | null;
      address?: string | null;
      description?: string | null;
      additionalDetails?: string[];
    };

    if (!Number.isFinite(body.id)) {
      return { status: 400, jsonBody: { error: "Missing 'id'" } };
    }
    if (body.title !== undefined && !body.title.trim()) {
      return { status: 400, jsonBody: { error: "'title' cannot be empty" } };
    }

    const detailsJson = body.additionalDetails !== undefined
      ? JSON.stringify(body.additionalDetails)
      : undefined;

    connection = await createConnection(token);

    const updated = await executeQuery(
      connection,
      `UPDATE dbo.Vacancies
       SET Title             = COALESCE(@Title, Title),
           BuildingId        = CASE WHEN @BuildingIdProvided = 1 THEN @BuildingId ELSE BuildingId END,
           Address           = CASE WHEN @AddressProvided = 1 THEN @Address ELSE Address END,
           Description       = CASE WHEN @DescProvided = 1 THEN @Description ELSE Description END,
           AdditionalDetails = COALESCE(@AdditionalDetails, AdditionalDetails),
           UpdatedAt         = GETUTCDATE()
       OUTPUT INSERTED.*
       WHERE Id = @Id`,
      [
        { name: "Id", type: TYPES.Int, value: body.id },
        { name: "Title", type: TYPES.NVarChar, value: body.title ?? null },
        { name: "BuildingIdProvided", type: TYPES.Bit, value: "buildingId" in body ? 1 : 0 },
        { name: "BuildingId", type: TYPES.Int, value: body.buildingId ?? null },
        { name: "AddressProvided", type: TYPES.Bit, value: "address" in body ? 1 : 0 },
        { name: "Address", type: TYPES.NVarChar, value: body.address ?? null },
        { name: "DescProvided", type: TYPES.Bit, value: "description" in body ? 1 : 0 },
        { name: "Description", type: TYPES.NVarChar, value: body.description ?? null },
        { name: "AdditionalDetails", type: TYPES.NVarChar, value: detailsJson ?? null },
      ],
    );

    if (!updated[0]) return { status: 404, jsonBody: { error: "Not found" } };
    const row = await fetchVacancyRow(connection, body.id);
    return { jsonBody: { vacancy: rowToVacancy(row ?? updated[0]) } };
  } catch (error: any) {
    return errorResponse("Failed to update vacancy", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("updateVacancy", {
  authLevel: "anonymous",
  handler: handleUpdateVacancy,
  methods: ["PUT"],
});

// ── DELETE /api/deleteVacancy ────────────────────────────────────────────────

async function handleDeleteVacancy(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = requireRole(request, VACANCY_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const body = (await request.json()) as { id: number };
    if (!Number.isFinite(body.id)) {
      return { status: 400, jsonBody: { error: "Missing 'id'" } };
    }

    connection = await createConnection(token);

    // Fetch images before deleting so we can clean up Blob Storage
    const rows = await executeQuery(
      connection,
      `SELECT Images, WordPressPostId FROM dbo.Vacancies WHERE Id = @Id`,
      [{ name: "Id", type: TYPES.Int, value: body.id }],
    );
    if (!rows[0]) return { status: 404, jsonBody: { error: "Not found" } };

    const images: string[] = JSON.parse((rows[0].Images as string) ?? "[]");
    const wpPostId = rows[0].WordPressPostId as number | null;

    // Unpublish from WordPress if published
    if (wpPostId) {
      await unpublishFromWordPress(wpPostId);
    }

    // Delete all blobs
    for (const url of images) {
      const blobName = extractBlobName(url);
      if (blobName) await deletePublicBlob(blobName).catch(() => undefined);
    }

    await executeQuery(
      connection,
      `DELETE FROM dbo.Vacancies WHERE Id = @Id`,
      [{ name: "Id", type: TYPES.Int, value: body.id }],
    );

    return { status: 200, jsonBody: { deleted: body.id } };
  } catch (error: any) {
    return errorResponse("Failed to delete vacancy", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("deleteVacancy", {
  authLevel: "anonymous",
  handler: handleDeleteVacancy,
  methods: ["DELETE"],
});

// ── POST /api/uploadVacancyImage ─────────────────────────────────────────────

async function handleUploadVacancyImage(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = requireRole(request, VACANCY_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const form = await request.formData();
    const fileEntry = form.get("file");
    const vacancyIdRaw = form.get("vacancyId");

    if (!fileEntry || typeof fileEntry === "string") {
      return { status: 400, jsonBody: { error: "Missing 'file'" } };
    }
    if (!vacancyIdRaw) {
      return { status: 400, jsonBody: { error: "Missing 'vacancyId'" } };
    }

    const vacancyId = Number(vacancyIdRaw);
    if (!Number.isFinite(vacancyId)) {
      return { status: 400, jsonBody: { error: "Invalid 'vacancyId'" } };
    }

    const file = fileEntry;
    const contentType = file.type;
    const originalName = file.name;

    if (!IMAGE_CONTENT_TYPES.has(contentType)) {
      return { status: 415, jsonBody: { error: "Unsupported image type" } };
    }
    if (file.size > MAX_SIZE_BYTES) {
      return { status: 413, jsonBody: { error: "File too large" } };
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const { url } = await uploadPublicBlob(buffer, originalName, contentType, `${vacancyId}`);

    context.log(`Uploaded vacancy image: ${url}`);

    connection = await createConnection(token);
    const updated = await executeQuery(
      connection,
      `UPDATE dbo.Vacancies
       SET Images = JSON_MODIFY(Images, 'append $', @Url),
           UpdatedAt = GETUTCDATE()
       OUTPUT INSERTED.*
       WHERE Id = @Id`,
      [
        { name: "Url", type: TYPES.NVarChar, value: url },
        { name: "Id", type: TYPES.Int, value: vacancyId },
      ],
    );

    if (!updated[0]) return { status: 404, jsonBody: { error: "Not found" } };
    const row = await fetchVacancyRow(connection, vacancyId);
    return { jsonBody: { vacancy: rowToVacancy(row ?? updated[0]) } };
  } catch (error: any) {
    return errorResponse("Failed to upload vacancy image", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("uploadVacancyImage", {
  authLevel: "anonymous",
  handler: handleUploadVacancyImage,
  methods: ["POST"],
});

// ── POST /api/deleteVacancyImage ─────────────────────────────────────────────

async function handleDeleteVacancyImage(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = requireRole(request, VACANCY_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const body = (await request.json()) as { id: number; imageUrl: string };

    if (!Number.isFinite(body.id)) {
      return { status: 400, jsonBody: { error: "Missing 'id'" } };
    }
    if (!body.imageUrl || typeof body.imageUrl !== "string") {
      return { status: 400, jsonBody: { error: "Missing 'imageUrl'" } };
    }

    connection = await createConnection(token);

    const rows = await executeQuery(
      connection,
      `SELECT Images FROM dbo.Vacancies WHERE Id = @Id`,
      [{ name: "Id", type: TYPES.Int, value: body.id }],
    );
    if (!rows[0]) return { status: 404, jsonBody: { error: "Not found" } };

    const current: string[] = JSON.parse((rows[0].Images as string) ?? "[]");
    const filtered = current.filter((u) => u !== body.imageUrl);

    const updated = await executeQuery(
      connection,
      `UPDATE dbo.Vacancies
       SET Images = @Images,
           UpdatedAt = GETUTCDATE()
       OUTPUT INSERTED.*
       WHERE Id = @Id`,
      [
        { name: "Images", type: TYPES.NVarChar, value: JSON.stringify(filtered) },
        { name: "Id", type: TYPES.Int, value: body.id },
      ],
    );

    if (!updated[0]) return { status: 404, jsonBody: { error: "Not found" } };

    const blobName = extractBlobName(body.imageUrl);
    if (blobName) await deletePublicBlob(blobName).catch(() => undefined);

    const row = await fetchVacancyRow(connection, body.id);
    return { jsonBody: { vacancy: rowToVacancy(row ?? updated[0]) } };
  } catch (error: any) {
    return errorResponse("Failed to delete vacancy image", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("deleteVacancyImage", {
  authLevel: "anonymous",
  handler: handleDeleteVacancyImage,
  methods: ["POST"],
});

// ── PUT /api/reorderVacancyImages ────────────────────────────────────────────

async function handleReorderVacancyImages(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = requireRole(request, VACANCY_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const body = (await request.json()) as { id: number; images: string[] };

    if (!Number.isFinite(body.id)) {
      return { status: 400, jsonBody: { error: "Missing 'id'" } };
    }
    if (!Array.isArray(body.images)) {
      return { status: 400, jsonBody: { error: "Missing 'images' array" } };
    }

    connection = await createConnection(token);
    const updated = await executeQuery(
      connection,
      `UPDATE dbo.Vacancies
       SET Images = @Images,
           UpdatedAt = GETUTCDATE()
       OUTPUT INSERTED.*
       WHERE Id = @Id`,
      [
        { name: "Images", type: TYPES.NVarChar, value: JSON.stringify(body.images) },
        { name: "Id", type: TYPES.Int, value: body.id },
      ],
    );

    if (!updated[0]) return { status: 404, jsonBody: { error: "Not found" } };
    const row = await fetchVacancyRow(connection, body.id);
    return { jsonBody: { vacancy: rowToVacancy(row ?? updated[0]) } };
  } catch (error: any) {
    return errorResponse("Failed to reorder vacancy images", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("reorderVacancyImages", {
  authLevel: "anonymous",
  handler: handleReorderVacancyImages,
  methods: ["PUT"],
});

// ── POST /api/uploadVacancySlotImage ────────────────────────────────────────

async function handleUploadVacancySlotImage(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = requireRole(request, VACANCY_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const form = await request.formData();
    const fileEntry = form.get("file");
    const vacancyIdRaw = form.get("vacancyId");
    const slotLabel = form.get("slotLabel");

    if (!fileEntry || typeof fileEntry === "string") {
      return { status: 400, jsonBody: { error: "Missing 'file'" } };
    }
    if (!vacancyIdRaw || !slotLabel || typeof slotLabel !== "string") {
      return { status: 400, jsonBody: { error: "Missing 'vacancyId' or 'slotLabel'" } };
    }

    const vacancyId = Number(vacancyIdRaw);
    if (!Number.isFinite(vacancyId)) {
      return { status: 400, jsonBody: { error: "Invalid 'vacancyId'" } };
    }

    const file = fileEntry;
    if (!IMAGE_CONTENT_TYPES.has(file.type)) {
      return { status: 415, jsonBody: { error: "Unsupported image type" } };
    }
    if (file.size > MAX_SIZE_BYTES) {
      return { status: 413, jsonBody: { error: "File too large" } };
    }

    connection = await createConnection(token);

    // Delete existing blob for this slot if present
    const existing = await executeQuery(
      connection,
      `SELECT SlotImages FROM dbo.Vacancies WHERE Id = @Id`,
      [{ name: "Id", type: TYPES.Int, value: vacancyId }],
    );
    if (!existing[0]) return { status: 404, jsonBody: { error: "Not found" } };

    const currentSlotImages: Record<string, string> = JSON.parse(
      (existing[0].SlotImages as string) ?? "{}",
    );
    if (currentSlotImages[slotLabel]) {
      const oldBlobName = extractBlobName(currentSlotImages[slotLabel]);
      if (oldBlobName) await deletePublicBlob(oldBlobName).catch(() => undefined);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const { url } = await uploadPublicBlob(
      buffer,
      file.name,
      file.type,
      `${vacancyId}/slots`,
    );

    context.log(`Uploaded slot image for vacancy ${vacancyId} slot "${slotLabel}": ${url}`);

    currentSlotImages[slotLabel] = url;

    await executeQuery(
      connection,
      `UPDATE dbo.Vacancies
       SET SlotImages = @SlotImages, UpdatedAt = GETUTCDATE()
       WHERE Id = @Id`,
      [
        { name: "SlotImages", type: TYPES.NVarChar, value: JSON.stringify(currentSlotImages) },
        { name: "Id", type: TYPES.Int, value: vacancyId },
      ],
    );

    const row = await fetchVacancyRow(connection, vacancyId);
    if (!row) return { status: 404, jsonBody: { error: "Not found" } };
    return { jsonBody: { vacancy: rowToVacancy(row) } };
  } catch (error: any) {
    return errorResponse("Failed to upload slot image", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("uploadVacancySlotImage", {
  authLevel: "anonymous",
  handler: handleUploadVacancySlotImage,
  methods: ["POST"],
});

// ── POST /api/deleteVacancySlotImage ─────────────────────────────────────────

async function handleDeleteVacancySlotImage(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = requireRole(request, VACANCY_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const body = (await request.json()) as { vacancyId: number; slotLabel: string };

    if (!Number.isFinite(body.vacancyId) || !body.slotLabel) {
      return { status: 400, jsonBody: { error: "Missing 'vacancyId' or 'slotLabel'" } };
    }

    connection = await createConnection(token);

    const rows = await executeQuery(
      connection,
      `SELECT SlotImages FROM dbo.Vacancies WHERE Id = @Id`,
      [{ name: "Id", type: TYPES.Int, value: body.vacancyId }],
    );
    if (!rows[0]) return { status: 404, jsonBody: { error: "Not found" } };

    const currentSlotImages: Record<string, string> = JSON.parse(
      (rows[0].SlotImages as string) ?? "{}",
    );

    const imageUrl = currentSlotImages[body.slotLabel];
    if (!imageUrl) return { status: 404, jsonBody: { error: "No image for this slot" } };

    const blobName = extractBlobName(imageUrl);
    if (blobName) await deletePublicBlob(blobName).catch(() => undefined);

    delete currentSlotImages[body.slotLabel];

    await executeQuery(
      connection,
      `UPDATE dbo.Vacancies
       SET SlotImages = @SlotImages, UpdatedAt = GETUTCDATE()
       WHERE Id = @Id`,
      [
        { name: "SlotImages", type: TYPES.NVarChar, value: JSON.stringify(currentSlotImages) },
        { name: "Id", type: TYPES.Int, value: body.vacancyId },
      ],
    );

    const row = await fetchVacancyRow(connection, body.vacancyId);
    if (!row) return { status: 404, jsonBody: { error: "Not found" } };
    return { jsonBody: { vacancy: rowToVacancy(row) } };
  } catch (error: any) {
    return errorResponse("Failed to delete slot image", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("deleteVacancySlotImage", {
  authLevel: "anonymous",
  handler: handleDeleteVacancySlotImage,
  methods: ["POST"],
});

// ── WordPress helpers ────────────────────────────────────────────────────────

function wpAuthHeader(): string {
  const user = process.env.WORDPRESS_USERNAME ?? "";
  const pass = process.env.WORDPRESS_APP_PASSWORD ?? "";
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

async function uploadImageToWp(imageUrl: string): Promise<number | null> {
  const wpBase = process.env.WORDPRESS_API_URL ?? "";
  try {
    const imgResp = await fetch(imageUrl);
    if (!imgResp.ok) return null;
    const buffer = Buffer.from(await imgResp.arrayBuffer());
    const contentType = imgResp.headers.get("content-type") ?? "image/jpeg";
    const filename = imageUrl.split("/").pop() ?? "image.jpg";

    const mediaResp = await fetch(`${wpBase}/wp/v2/media`, {
      method: "POST",
      headers: {
        Authorization: wpAuthHeader(),
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
      body: buffer,
    });
    if (!mediaResp.ok) return null;
    const media = (await mediaResp.json()) as { id: number };
    return media.id;
  } catch {
    return null;
  }
}

export async function unpublishFromWordPress(wpPostId: number): Promise<void> {
  const wpBase = process.env.WORDPRESS_API_URL ?? "";
  await fetch(`${wpBase}/wp/v2/tenancy/${wpPostId}`, {
    method: "POST",
    headers: {
      Authorization: wpAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ status: "draft" }),
  }).catch(() => undefined);
}

// ── POST /api/publishVacancy ─────────────────────────────────────────────────

async function handlePublishVacancy(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = requireRole(request, VACANCY_ROLES);
  if (roleCheck) return roleCheck;

  const wpBase = process.env.WORDPRESS_API_URL;
  if (!wpBase) {
    return { status: 500, jsonBody: { error: "WORDPRESS_API_URL not configured" } };
  }

  let connection;
  try {
    const body = (await request.json()) as { id: number };
    if (!Number.isFinite(body.id)) {
      return { status: 400, jsonBody: { error: "Missing 'id'" } };
    }

    connection = await createConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT v.*, b.BuildingName, b.HeroImageUrl
       FROM dbo.Vacancies v
       LEFT JOIN dbo.Buildings b ON b.BuildingID = v.BuildingId
       WHERE v.Id = @Id`,
      [{ name: "Id", type: TYPES.Int, value: body.id }],
    );
    if (!rows[0]) return { status: 404, jsonBody: { error: "Not found" } };

    const v = rowToVacancy(rows[0]);
    const buildingName = (rows[0].BuildingName as string | null) ?? null;
    const heroImageUrl = v.buildingHeroImageUrl as string | null;
    const slotImages = v.slotImages as Record<string, string>;
    const vacancyImages = v.images as string[];
    const slotUrls = GALLERY_SLOT_LABELS
      .map((label) => slotImages[label])
      .filter((url): url is string => Boolean(url));
    const images = [
      ...(heroImageUrl ? [heroImageUrl] : []),
      ...slotUrls,
      ...vacancyImages,
    ];
    const additionalDetails = v.additionalDetails as string[];

    context.log(`Publishing vacancy ${body.id} — uploading ${images.length} images to WP`);
    const mediaIds: number[] = [];
    for (const url of images) {
      const id = await uploadImageToWp(url);
      if (id !== null) mediaIds.push(id);
    }

    const payload = buildWpPayload(
      v.title as string,
      buildingName,
      v.description as string | null,
      additionalDetails,
      mediaIds[0] ?? null,
    );

    const wpPostId = v.wordpressPostId as number | null;
    const wpEndpoint = wpPostId
      ? `${wpBase}/wp/v2/tenancy/${wpPostId}`
      : `${wpBase}/wp/v2/tenancy`;
    const wpMethod = wpPostId ? "PUT" : "POST";

    const wpResp = await fetch(wpEndpoint, {
      method: wpMethod,
      headers: {
        Authorization: wpAuthHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!wpResp.ok) {
      const errText = await wpResp.text();
      context.log(`WP error: ${wpResp.status} ${errText}`);
      return { status: 502, jsonBody: { error: `WordPress returned ${wpResp.status}` } };
    }

    const wpPost = (await wpResp.json()) as { id: number; slug: string };

    const updated = await executeQuery(
      connection,
      `UPDATE dbo.Vacancies
       SET Status = 'published',
           WordPressPostId = @WpPostId,
           WordPressSlug = @WpSlug,
           LastSyncedAt = GETUTCDATE(),
           UpdatedAt = GETUTCDATE()
       OUTPUT INSERTED.*
       WHERE Id = @Id`,
      [
        { name: "WpPostId", type: TYPES.Int, value: wpPost.id },
        { name: "WpSlug", type: TYPES.NVarChar, value: wpPost.slug },
        { name: "Id", type: TYPES.Int, value: body.id },
      ],
    );

    return { jsonBody: { vacancy: rowToVacancy(updated[0]) } };
  } catch (error: any) {
    return errorResponse("Failed to publish vacancy", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("publishVacancy", {
  authLevel: "anonymous",
  handler: handlePublishVacancy,
  methods: ["POST"],
});

// ── POST /api/unpublishVacancy ───────────────────────────────────────────────

async function handleUnpublishVacancy(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = requireRole(request, VACANCY_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const body = (await request.json()) as { id: number };
    if (!Number.isFinite(body.id)) {
      return { status: 400, jsonBody: { error: "Missing 'id'" } };
    }

    connection = await createConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT WordPressPostId FROM dbo.Vacancies WHERE Id = @Id`,
      [{ name: "Id", type: TYPES.Int, value: body.id }],
    );
    if (!rows[0]) return { status: 404, jsonBody: { error: "Not found" } };

    const existingWpPostId = rows[0].WordPressPostId as number | null;
    if (existingWpPostId) await unpublishFromWordPress(existingWpPostId);

    const updated = await executeQuery(
      connection,
      `UPDATE dbo.Vacancies
       SET Status = 'draft',
           WordPressPostId = NULL,
           WordPressSlug = NULL,
           UpdatedAt = GETUTCDATE()
       OUTPUT INSERTED.*
       WHERE Id = @Id`,
      [{ name: "Id", type: TYPES.Int, value: body.id }],
    );

    return { jsonBody: { vacancy: rowToVacancy(updated[0]) } };
  } catch (error: any) {
    return errorResponse("Failed to unpublish vacancy", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("unpublishVacancy", {
  authLevel: "anonymous",
  handler: handleUnpublishVacancy,
  methods: ["POST"],
});

// ── Shared helpers ───────────────────────────────────────────────────────────

export function extractBlobName(publicUrl: string): string | null {
  const marker = "/vacancies/";
  const idx = publicUrl.indexOf(marker);
  if (idx === -1) return null;
  return publicUrl.slice(idx + marker.length);
}
