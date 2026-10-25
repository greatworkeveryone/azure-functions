import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { closeConnection, createRequestConnection, executeQuery } from "../db";
import { AppRole, extractToken, errorResponse, requireRole, unauthorizedResponse } from "../auth";
import { uploadPublicBlob, deletePublicBlob, vacanciesReadSasUrl, vacanciesBlobNameFromUrl } from "../blob-storage";
import { isBlobName, VACANCY_SHAPE } from "../blob-names";
import { MAX_SIZE_BYTES } from "../upload-constants";
import { clearBuildingsCache } from "./getBuildings";

const IMAGE_CONTENT_TYPES = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/webp",
]);

function extractHeroBlobName(publicUrl: string, buildingId: number): string | null {
  const name = vacanciesBlobNameFromUrl(publicUrl);
  return name?.startsWith(`building-hero/${buildingId}/`) && isBlobName(name, VACANCY_SHAPE) ? name : null;
}

// ── POST /api/uploadBuildingHeroImage ────────────────────────────────────────

async function handleUploadBuildingHeroImage(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, [AppRole.ADMIN]);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const form = await request.formData();
    const fileEntry = form.get("file");
    const buildingIdRaw = form.get("buildingId");

    if (!fileEntry || typeof fileEntry === "string") {
      return { status: 400, jsonBody: { error: "Missing 'file'" } };
    }
    if (!buildingIdRaw) {
      return { status: 400, jsonBody: { error: "Missing 'buildingId'" } };
    }

    const buildingId = Number(buildingIdRaw);
    if (!Number.isSafeInteger(buildingId)) {
      return { status: 400, jsonBody: { error: "Invalid 'buildingId'" } };
    }

    const file = fileEntry;
    if (!IMAGE_CONTENT_TYPES.has(file.type)) {
      return { status: 415, jsonBody: { error: "Unsupported image type" } };
    }
    if (file.size > MAX_SIZE_BYTES) {
      return { status: 413, jsonBody: { error: "File too large" } };
    }

    connection = await createRequestConnection(token);

    // Read before upload; keep the old image live until its replacement is saved.
    const existing = await executeQuery(
      connection,
      `SELECT HeroImageUrl FROM dbo.Buildings WHERE BuildingID = @BuildingId`,
      [{ name: "BuildingId", type: TYPES.Int, value: buildingId }],
    );
    if (!existing.length) return { status: 404, jsonBody: { error: "Building not found" } };
    const oldBlobName = existing[0].HeroImageUrl ? extractHeroBlobName(existing[0].HeroImageUrl as string, buildingId) : null;

    const buffer = Buffer.from(await file.arrayBuffer());
    const { blobName, url } = await uploadPublicBlob(
      buffer,
      file.name,
      file.type,
      `building-hero/${buildingId}`,
    );

    context.log(`Uploaded building hero image for building ${buildingId}: ${url}`);

    try {
      await executeQuery(
        connection,
        `UPDATE dbo.Buildings SET HeroImageUrl = @Url WHERE BuildingID = @BuildingId`,
        [
          { name: "Url", type: TYPES.NVarChar, value: url },
          { name: "BuildingId", type: TYPES.Int, value: buildingId },
        ],
      );
    } catch (error) {
      // The UPDATE may have committed with its acknowledgement lost: delete only when a fresh read proves the new URL is not saved (an orphan is harmless, a deleted referenced image is data loss).
      const saved = await executeQuery(
        connection,
        `SELECT BuildingID FROM dbo.Buildings WHERE BuildingID = @BuildingId AND HeroImageUrl = @Url`,
        [
          { name: "BuildingId", type: TYPES.Int, value: buildingId },
          { name: "Url", type: TYPES.NVarChar, value: url },
        ],
      ).then((rows) => rows.length > 0, () => null);
      if (saved === false) await deletePublicBlob(blobName).catch(() => undefined);
      else context.warn(`uploadBuildingHeroImage kept ${blobName}: ${saved ? "the building row references it" : "reference check failed"}`);
      throw error;
    }
    if (oldBlobName) await deletePublicBlob(oldBlobName).catch(() => undefined);

    clearBuildingsCache();
    // Persist the bare URL (above) but hand the client a short-lived read SAS so
    // the just-uploaded image loads from the private container.
    return { jsonBody: { heroImageUrl: vacanciesReadSasUrl(url) } };
  } catch (error: any) {
    return errorResponse("Failed to upload building hero image", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("uploadBuildingHeroImage", {
  authLevel: "anonymous",
  handler: handleUploadBuildingHeroImage,
  methods: ["POST"],
});

// ── DELETE /api/deleteBuildingHeroImage ──────────────────────────────────────

async function handleDeleteBuildingHeroImage(
  request: HttpRequest,
  _context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, [AppRole.ADMIN]);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const body = (await request.json()) as { buildingId: number };

    if (!Number.isSafeInteger(body.buildingId)) {
      return { status: 400, jsonBody: { error: "Missing 'buildingId'" } };
    }

    connection = await createRequestConnection(token);

    const rows = await executeQuery(
      connection,
      `SELECT HeroImageUrl FROM dbo.Buildings WHERE BuildingID = @BuildingId`,
      [{ name: "BuildingId", type: TYPES.Int, value: body.buildingId }],
    );

    if (!rows[0]?.HeroImageUrl) {
      return { status: 404, jsonBody: { error: "No hero image set" } };
    }

    const blobName = extractHeroBlobName(rows[0].HeroImageUrl as string, body.buildingId);
    await executeQuery(
      connection,
      `UPDATE dbo.Buildings SET HeroImageUrl = NULL WHERE BuildingID = @BuildingId`,
      [{ name: "BuildingId", type: TYPES.Int, value: body.buildingId }],
    );

    if (blobName) await deletePublicBlob(blobName).catch(() => undefined);
    clearBuildingsCache();
    return { status: 200, jsonBody: { deleted: true } };
  } catch (error: any) {
    return errorResponse("Failed to delete building hero image", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("deleteBuildingHeroImage", {
  authLevel: "anonymous",
  handler: handleDeleteBuildingHeroImage,
  methods: ["DELETE"],
});
