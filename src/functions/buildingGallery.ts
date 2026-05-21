import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { closeConnection, createConnection, executeQuery } from "../db";
import { AppRole, extractToken, errorResponse, requireRole, unauthorizedResponse } from "../auth";
import { uploadPublicBlob, deletePublicBlob } from "../blob-storage";
import { MAX_SIZE_BYTES } from "../upload-constants";
import { clearBuildingsCache } from "./getBuildings";

const IMAGE_CONTENT_TYPES = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/webp",
]);

function extractHeroBlobName(publicUrl: string): string | null {
  const marker = "/building-hero/";
  const idx = publicUrl.indexOf(marker);
  if (idx === -1) return null;
  return publicUrl.slice(idx + marker.length);
}

// ── POST /api/uploadBuildingHeroImage ────────────────────────────────────────

async function handleUploadBuildingHeroImage(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = requireRole(request, [AppRole.ADMIN]);
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
    if (!Number.isFinite(buildingId)) {
      return { status: 400, jsonBody: { error: "Invalid 'buildingId'" } };
    }

    const file = fileEntry;
    if (!IMAGE_CONTENT_TYPES.has(file.type)) {
      return { status: 415, jsonBody: { error: "Unsupported image type" } };
    }
    if (file.size > MAX_SIZE_BYTES) {
      return { status: 413, jsonBody: { error: "File too large" } };
    }

    connection = await createConnection(token);

    // Delete existing hero image blob if present
    const existing = await executeQuery(
      connection,
      `SELECT HeroImageUrl FROM dbo.Buildings WHERE BuildingID = @BuildingId`,
      [{ name: "BuildingId", type: TYPES.Int, value: buildingId }],
    );
    if (existing[0]?.HeroImageUrl) {
      const oldBlobName = extractHeroBlobName(existing[0].HeroImageUrl as string);
      if (oldBlobName) await deletePublicBlob(oldBlobName).catch(() => undefined);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const { url } = await uploadPublicBlob(
      buffer,
      file.name,
      file.type,
      `building-hero/${buildingId}`,
    );

    context.log(`Uploaded building hero image for building ${buildingId}: ${url}`);

    await executeQuery(
      connection,
      `UPDATE dbo.Buildings SET HeroImageUrl = @Url WHERE BuildingID = @BuildingId`,
      [
        { name: "Url", type: TYPES.NVarChar, value: url },
        { name: "BuildingId", type: TYPES.Int, value: buildingId },
      ],
    );

    clearBuildingsCache();
    return { jsonBody: { heroImageUrl: url } };
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
  const roleCheck = requireRole(request, [AppRole.ADMIN]);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const body = (await request.json()) as { buildingId: number };

    if (!Number.isFinite(body.buildingId)) {
      return { status: 400, jsonBody: { error: "Missing 'buildingId'" } };
    }

    connection = await createConnection(token);

    const rows = await executeQuery(
      connection,
      `SELECT HeroImageUrl FROM dbo.Buildings WHERE BuildingID = @BuildingId`,
      [{ name: "BuildingId", type: TYPES.Int, value: body.buildingId }],
    );

    if (!rows[0]?.HeroImageUrl) {
      return { status: 404, jsonBody: { error: "No hero image set" } };
    }

    const blobName = extractHeroBlobName(rows[0].HeroImageUrl as string);
    if (blobName) await deletePublicBlob(blobName).catch(() => undefined);

    await executeQuery(
      connection,
      `UPDATE dbo.Buildings SET HeroImageUrl = NULL WHERE BuildingID = @BuildingId`,
      [{ name: "BuildingId", type: TYPES.Int, value: body.buildingId }],
    );

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
