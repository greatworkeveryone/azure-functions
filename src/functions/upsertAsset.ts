// POST /api/upsertAsset
//
// Body: AssetInput (see ../assetRegister). Create needs buildingId, name and
// category; everything else is optional. With assetId - or, for imported
// assets, with source + externalId matching an existing row - it patches:
// omitted fields are left alone, null clears a nullable field.
//
// Rules enforced here (one transaction, so the checks see what the write sees):
//   - category is a maintenance category; assetTypeId is an ACTIVE type of that category
//   - locationId and parentAssetId belong to the asset's building; no parent cycles
//   - assetTag is unique per building among live assets (409 naming the holder)
//   - buildingId, source and externalId never change after creation; archived assets are read-only
//   - verification: `verified: true` stamps the caller; otherwise changing locationId,
//     category, assetTypeId/assetTypeNote, make, model or serialNumber clears an
//     existing stamp. Any other edit leaves it alone.
// Response: { asset, created } - asset is AssetApi including specs.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import type { Connection } from "tedious";
import {
  buildUpdateSet,
  closeConnection,
  createRequestConnection,
  executeQuery,
  type SqlRow,
} from "../db";
import { errorResponse } from "../auth";
import {
  AssetApi,
  AssetInput,
  EDIT_ASSETS_ROLES,
  UNIQUE_INDEXES,
  assetIdentityFromRow,
  assetRowToApi,
  identityChanged,
  parseAssetInput,
  precheckAssetInput,
  resolveVerification,
  uniqueViolationName,
  validateAssetCreate,
} from "../assetRegister";
import {
  Caller,
  TxResult,
  assetParentWouldCycle,
  authorizeWrite,
  badRequest,
  buildingExists,
  conflict,
  errorMessage,
  fetchAsset,
  fetchAssetType,
  fetchLocation,
  inTransaction,
  notFound,
  readJsonBody,
  txFail,
  txOk,
} from "../assetRegisterSupport";

interface UpsertAssetResult {
  asset: AssetApi;
  created: boolean;
}

const ASSET_UPDATE_COLUMNS = {
  AssetTag: TYPES.NVarChar,
  AssetTypeId: TYPES.Int,
  AssetTypeNote: TYPES.NVarChar,
  Category: TYPES.NVarChar,
  Criticality: TYPES.NVarChar,
  InstallDate: TYPES.Date,
  LocationId: TYPES.Int,
  Make: TYPES.NVarChar,
  Model: TYPES.NVarChar,
  Name: TYPES.NVarChar,
  Notes: TYPES.NVarChar,
  ParentAssetId: TYPES.Int,
  Responsibility: TYPES.NVarChar,
  SerialNumber: TYPES.NVarChar,
  ServiceContractorId: TYPES.Int,
  Specs: TYPES.NVarChar,
  Status: TYPES.NVarChar,
  WarrantyExpiry: TYPES.Date,
};

const num = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

/** YYYY-MM-DD -> a Date at UTC midnight (tedious writes DATE from the UTC parts). */
const toSqlDate = (value: string | null | undefined): Date | null | undefined =>
  value === undefined || value === null ? value : new Date(`${value}T00:00:00.000Z`);

const toSpecsJson = (value: Record<string, unknown> | null | undefined): string | null | undefined =>
  value === undefined || value === null ? value : JSON.stringify(value);

/** Imported assets are matched on (source, externalId) so re-imports update in place. */
async function findByExternalId(
  connection: Connection,
  source: string,
  externalId: string,
): Promise<SqlRow | null> {
  const rows = await executeQuery(
    connection,
    `SELECT AssetId FROM dbo.Assets WITH (UPDLOCK, ROWLOCK)
      WHERE Source = @Source AND ExternalId = @ExternalId`,
    [
      { name: "Source", type: TYPES.NVarChar, value: source },
      { name: "ExternalId", type: TYPES.NVarChar, value: externalId },
    ],
  );
  return rows[0] ? fetchAsset(connection, Number(rows[0].AssetId), { forUpdate: true }) : null;
}

/** Everything the write depends on, checked before the write. Returns the rejection, or null. */
async function checkReferences(
  connection: Connection,
  input: AssetInput,
  current: SqlRow | null,
  buildingId: number,
  category: string,
): Promise<HttpResponseInit | null> {
  const currentId = current ? Number(current.AssetId) : undefined;

  if (input.locationId != null && input.locationId !== num(current?.LocationId)) {
    const location = await fetchLocation(connection, input.locationId);
    if (!location) return badRequest("Unknown location");
    if (Number(location.BuildingId) !== buildingId) {
      return badRequest("Location belongs to a different building");
    }
    if (!location.Active) return badRequest("Location is inactive");
  }

  if (input.parentAssetId != null && input.parentAssetId !== num(current?.ParentAssetId)) {
    if (input.parentAssetId === currentId) return badRequest("An asset cannot be its own parent");
    const parents = await executeQuery(
      connection,
      `SELECT AssetId, BuildingId, ArchivedAt FROM dbo.Assets WHERE AssetId = @ParentAssetId`,
      [{ name: "ParentAssetId", type: TYPES.Int, value: input.parentAssetId }],
    );
    const parent = parents[0];
    if (!parent) return badRequest("Unknown parent asset");
    if (Number(parent.BuildingId) !== buildingId) {
      return badRequest("Parent asset belongs to a different building");
    }
    if (parent.ArchivedAt) return badRequest("Parent asset is archived");
    if (currentId !== undefined && (await assetParentWouldCycle(connection, currentId, input.parentAssetId))) {
      return badRequest("That parent would make the asset its own ancestor");
    }
  }

  if (
    input.serviceContractorId != null &&
    input.serviceContractorId !== num(current?.ServiceContractorId)
  ) {
    const contractors = await executeQuery(
      connection,
      `SELECT ContractorID FROM dbo.Contractors WHERE ContractorID = @ContractorId`,
      [{ name: "ContractorId", type: TYPES.Int, value: input.serviceContractorId }],
    );
    if (contractors.length === 0) return badRequest("Unknown service contractor");
  }

  // The type must sit in the asset's category - also when only the category moves.
  const storedTypeId = num(current?.AssetTypeId);
  const nextTypeId = input.assetTypeId !== undefined ? input.assetTypeId : storedTypeId;
  const categoryMoved =
    current !== null && category.toLowerCase() !== String(current.Category).toLowerCase();
  if (nextTypeId != null && (input.assetTypeId !== undefined || categoryMoved)) {
    const type = await fetchAssetType(connection, nextTypeId);
    if (!type) return badRequest("Unknown asset type");
    if (input.assetTypeId !== undefined && input.assetTypeId !== storedTypeId && !type.Active) {
      return badRequest("That asset type is inactive");
    }
    if (String(type.Category).toLowerCase() !== category.toLowerCase()) {
      return badRequest(
        `Asset type "${type.Name}" belongs to ${type.Category}, not ${category}. Pick a type in ${category} or set assetTypeId to null.`,
      );
    }
  }

  if (input.assetTag != null && (current === null || input.assetTag !== (current.AssetTag ?? null))) {
    const clash = await executeQuery(
      connection,
      `SELECT TOP 1 AssetId, Name FROM dbo.Assets
        WHERE BuildingId = @BuildingId AND AssetTag = @AssetTag
          AND ArchivedAt IS NULL AND AssetId <> @AssetId`,
      [
        { name: "BuildingId", type: TYPES.Int, value: buildingId },
        { name: "AssetTag", type: TYPES.NVarChar, value: input.assetTag },
        { name: "AssetId", type: TYPES.Int, value: currentId ?? 0 },
      ],
    );
    if (clash.length > 0) {
      return conflict(
        `Asset tag "${input.assetTag}" is already used by "${String(clash[0].Name)}" (asset ${Number(clash[0].AssetId)}) in this building`,
      );
    }
  }

  return null;
}

async function insertAsset(
  connection: Connection,
  input: AssetInput,
  caller: Caller,
): Promise<number> {
  const inserted = await executeQuery(
    connection,
    `INSERT INTO dbo.Assets
       (BuildingId, LocationId, ParentAssetId, AssetTag, Name, Category, AssetTypeId, AssetTypeNote,
        Make, Model, SerialNumber, InstallDate, WarrantyExpiry, Responsibility, Status, Criticality,
        ServiceContractorId, Specs, Notes, Source, ExternalId, VerifiedAt, VerifiedBy, CreatedBy, UpdatedBy)
     OUTPUT INSERTED.AssetId
     VALUES
       (@BuildingId, @LocationId, @ParentAssetId, @AssetTag, @Name, @Category, @AssetTypeId, @AssetTypeNote,
        @Make, @Model, @SerialNumber, @InstallDate, @WarrantyExpiry, @Responsibility, @Status, @Criticality,
        @ServiceContractorId, @Specs, @Notes, @Source, @ExternalId,
        CASE WHEN @Verify = 1 THEN SYSUTCDATETIME() END,
        CASE WHEN @Verify = 1 THEN @Caller END,
        @Caller, @Caller)`,
    [
      { name: "BuildingId", type: TYPES.Int, value: input.buildingId },
      { name: "LocationId", type: TYPES.Int, value: input.locationId ?? null },
      { name: "ParentAssetId", type: TYPES.Int, value: input.parentAssetId ?? null },
      { name: "AssetTag", type: TYPES.NVarChar, value: input.assetTag ?? null },
      { name: "Name", type: TYPES.NVarChar, value: input.name },
      { name: "Category", type: TYPES.NVarChar, value: input.category },
      { name: "AssetTypeId", type: TYPES.Int, value: input.assetTypeId ?? null },
      { name: "AssetTypeNote", type: TYPES.NVarChar, value: input.assetTypeNote ?? null },
      { name: "Make", type: TYPES.NVarChar, value: input.make ?? null },
      { name: "Model", type: TYPES.NVarChar, value: input.model ?? null },
      { name: "SerialNumber", type: TYPES.NVarChar, value: input.serialNumber ?? null },
      { name: "InstallDate", type: TYPES.Date, value: toSqlDate(input.installDate) ?? null },
      { name: "WarrantyExpiry", type: TYPES.Date, value: toSqlDate(input.warrantyExpiry) ?? null },
      { name: "Responsibility", type: TYPES.NVarChar, value: input.responsibility ?? "owner" },
      { name: "Status", type: TYPES.NVarChar, value: input.status ?? "active" },
      { name: "Criticality", type: TYPES.NVarChar, value: input.criticality ?? "standard" },
      { name: "ServiceContractorId", type: TYPES.Int, value: input.serviceContractorId ?? null },
      { name: "Specs", type: TYPES.NVarChar, value: toSpecsJson(input.specs) ?? null },
      { name: "Notes", type: TYPES.NVarChar, value: input.notes ?? null },
      { name: "Source", type: TYPES.NVarChar, value: input.source ?? "manual" },
      { name: "ExternalId", type: TYPES.NVarChar, value: input.externalId ?? null },
      { name: "Verify", type: TYPES.Bit, value: input.verified === true },
      { name: "Caller", type: TYPES.NVarChar, value: caller.name },
    ],
  );
  return Number(inserted[0].AssetId);
}

/** Returns a rejection when there is nothing to write. */
async function updateAsset(
  connection: Connection,
  assetId: number,
  input: AssetInput,
  current: SqlRow,
  caller: Caller,
): Promise<HttpResponseInit | null> {
  const action = resolveVerification({
    identityChanged: identityChanged(assetIdentityFromRow(current), input),
    isVerified: current.VerifiedAt != null,
    requested: input.verified === true,
  });

  const update = buildUpdateSet(ASSET_UPDATE_COLUMNS, {
    AssetTag: input.assetTag,
    AssetTypeId: input.assetTypeId,
    AssetTypeNote: input.assetTypeNote,
    Category: input.category,
    Criticality: input.criticality,
    InstallDate: toSqlDate(input.installDate),
    LocationId: input.locationId,
    Make: input.make,
    Model: input.model,
    Name: input.name,
    Notes: input.notes,
    ParentAssetId: input.parentAssetId,
    Responsibility: input.responsibility,
    SerialNumber: input.serialNumber,
    ServiceContractorId: input.serviceContractorId,
    Specs: toSpecsJson(input.specs),
    Status: input.status,
    WarrantyExpiry: toSqlDate(input.warrantyExpiry),
  });
  if (!update && action === "keep") return badRequest("No fields to update");

  const setParts = update ? [update.setClause] : [];
  setParts.push("UpdatedAt = SYSUTCDATETIME()", "UpdatedBy = @UpdatedBy");
  if (action === "stamp") setParts.push("VerifiedAt = SYSUTCDATETIME()", "VerifiedBy = @UpdatedBy");
  if (action === "clear") setParts.push("VerifiedAt = NULL", "VerifiedBy = NULL");
  const updateSet = setParts.join(", ");

  await executeQuery(
    connection,
    `UPDATE dbo.Assets SET ${updateSet} WHERE AssetId = @AssetId`,
    [
      { name: "AssetId", type: TYPES.Int, value: assetId },
      { name: "UpdatedBy", type: TYPES.NVarChar, value: caller.name },
      ...(update ? update.params : []),
    ],
  );
  return null;
}

async function applyUpsert(
  connection: Connection,
  input: AssetInput,
  caller: Caller,
): Promise<TxResult<UpsertAssetResult>> {
  let current: SqlRow | null = null;
  let matchedByExternalId = false;
  if (input.assetId !== undefined) {
    current = await fetchAsset(connection, input.assetId, { forUpdate: true });
    if (!current) return txFail(notFound("Asset not found"));
  } else if (input.externalId != null) {
    current = await findByExternalId(connection, input.source ?? "manual", input.externalId);
    matchedByExternalId = current !== null;
  }

  if (current) {
    if (current.ArchivedAt) return txFail(conflict("This asset is archived and can no longer be edited"));
    if (input.buildingId !== undefined && input.buildingId !== Number(current.BuildingId)) {
      return txFail(badRequest("An asset cannot move to a different building"));
    }
    // A match on (source, externalId) already proves both are unchanged.
    if (!matchedByExternalId) {
      if (input.source !== undefined && input.source !== current.Source) {
        return txFail(badRequest("source cannot be changed after creation"));
      }
      if (input.externalId !== undefined && input.externalId !== (current.ExternalId ?? null)) {
        return txFail(badRequest("externalId cannot be changed after creation"));
      }
    }
  } else {
    const invalid = validateAssetCreate(input);
    if (invalid) return txFail(badRequest(invalid));
    if (!(await buildingExists(connection, input.buildingId as number))) {
      return txFail(badRequest("Unknown building"));
    }
  }

  const buildingId = current ? Number(current.BuildingId) : (input.buildingId as number);
  const category = input.category ?? (current ? String(current.Category) : "");
  const rejected = await checkReferences(connection, input, current, buildingId, category);
  if (rejected) return txFail(rejected);

  let assetId: number;
  if (current) {
    assetId = Number(current.AssetId);
    const rejection = await updateAsset(connection, assetId, input, current, caller);
    if (rejection) return txFail(rejection);
  } else {
    assetId = await insertAsset(connection, input, caller);
  }

  const saved = await fetchAsset(connection, assetId);
  return txOk({ asset: assetRowToApi(saved as SqlRow), created: current === null });
}

export async function upsertAsset(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, EDIT_ASSETS_ROLES);
  if (!auth.ok) return auth.response;

  const body = await readJsonBody(request);
  if (!body) return badRequest("Request body must be a JSON object");
  const parsed = parseAssetInput(body);
  if (!parsed.ok) return badRequest(parsed.error);
  const hopeless = precheckAssetInput(parsed.value);
  if (hopeless) return badRequest(hopeless);

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const conn = connection;
    const outcome = await inTransaction(conn, () => applyUpsert(conn, parsed.value, auth.caller));
    if (!outcome.ok) return outcome.response;
    return { jsonBody: outcome.value, status: 200 };
  } catch (error) {
    const violated = uniqueViolationName(error);
    if (violated === UNIQUE_INDEXES.assetTag) {
      return conflict("That asset tag is already used by another asset in this building");
    }
    if (violated === UNIQUE_INDEXES.assetExternal) {
      return conflict("An asset with that external id already exists");
    }
    context.error("upsertAsset failed:", errorMessage(error));
    return errorResponse("Failed to save asset", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("upsertAsset", { authLevel: "anonymous", handler: upsertAsset, methods: ["POST"] });
