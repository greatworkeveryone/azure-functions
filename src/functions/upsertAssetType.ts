// POST /api/upsertAssetType
//
// Managers and admins only - staff must not be able to grow the taxonomy.
// Body: AssetTypeInput. Without assetTypeId it creates (category and name
// required); with it, it patches. Names are unique among ACTIVE types within a
// category. A type that assets use can be renamed, reordered or retired
// (active: false - existing assets keep it), but not moved to another category.
// Response: { assetType, created }.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import type { Connection } from "tedious";
import { buildUpdateSet, closeConnection, createRequestConnection, executeQuery } from "../db";
import { errorResponse } from "../auth";
import {
  AssetTypeApi,
  AssetTypeInput,
  MANAGE_ASSET_TYPES_ROLES,
  assetTypeRowToApi,
  parseAssetTypeInput,
  uniqueViolationName,
} from "../assetRegister";
import {
  Caller,
  TxResult,
  authorizeWrite,
  badRequest,
  conflict,
  errorMessage,
  fetchAssetType,
  inTransaction,
  notFound,
  readJsonBody,
  txFail,
  txOk,
} from "../assetRegisterSupport";

interface UpsertAssetTypeResult {
  assetType: AssetTypeApi;
  created: boolean;
}

const ASSET_TYPE_UPDATE_COLUMNS = {
  Active: TYPES.Bit,
  Category: TYPES.NVarChar,
  Name: TYPES.NVarChar,
  SortOrder: TYPES.Int,
};

async function createAssetType(
  connection: Connection,
  input: AssetTypeInput,
  caller: Caller,
): Promise<TxResult<UpsertAssetTypeResult>> {
  const inserted = await executeQuery(
    connection,
    `INSERT INTO dbo.AssetTypes (Category, Name, Active, SortOrder, CreatedBy, UpdatedBy)
     OUTPUT INSERTED.AssetTypeId
     VALUES (
       @Category, @Name, @Active,
       ISNULL(@SortOrder, (SELECT ISNULL(MAX(s.SortOrder), -1) + 1 FROM dbo.AssetTypes s WHERE s.Category = @Category)),
       @Caller, @Caller
     )`,
    [
      { name: "Category", type: TYPES.NVarChar, value: input.category },
      { name: "Name", type: TYPES.NVarChar, value: input.name },
      { name: "Active", type: TYPES.Bit, value: input.active ?? true },
      { name: "SortOrder", type: TYPES.Int, value: input.sortOrder ?? null },
      { name: "Caller", type: TYPES.NVarChar, value: caller.name },
    ],
  );
  const created = await fetchAssetType(connection, Number(inserted[0].AssetTypeId));
  return txOk({ assetType: assetTypeRowToApi(created as NonNullable<typeof created>), created: true });
}

async function updateAssetType(
  connection: Connection,
  input: AssetTypeInput,
  caller: Caller,
): Promise<TxResult<UpsertAssetTypeResult>> {
  const assetTypeId = input.assetTypeId as number;
  const current = await fetchAssetType(connection, assetTypeId, { forUpdate: true });
  if (!current) return txFail(notFound("Asset type not found"));

  if (input.category !== undefined && input.category.toLowerCase() !== String(current.Category).toLowerCase()) {
    const usage = await executeQuery(
      connection,
      `SELECT COUNT(*) AS Total FROM dbo.Assets WHERE AssetTypeId = @AssetTypeId`,
      [{ name: "AssetTypeId", type: TYPES.Int, value: assetTypeId }],
    );
    const inUse = Number(usage[0]?.Total ?? 0);
    if (inUse > 0) {
      return txFail(
        conflict(
          `${inUse} asset(s) use this type, so it cannot move category. Retire it (active: false) and create a new type instead.`,
        ),
      );
    }
  }

  const update = buildUpdateSet(ASSET_TYPE_UPDATE_COLUMNS, {
    Active: input.active,
    Category: input.category,
    Name: input.name,
    SortOrder: input.sortOrder,
  });
  if (!update) return txFail(badRequest("No fields to update"));

  await executeQuery(
    connection,
    `UPDATE dbo.AssetTypes
        SET ${update.setClause}, UpdatedAt = SYSUTCDATETIME(), UpdatedBy = @UpdatedBy
      WHERE AssetTypeId = @AssetTypeId`,
    [
      { name: "AssetTypeId", type: TYPES.Int, value: assetTypeId },
      { name: "UpdatedBy", type: TYPES.NVarChar, value: caller.name },
      ...update.params,
    ],
  );
  const updated = await fetchAssetType(connection, assetTypeId);
  return txOk({ assetType: assetTypeRowToApi(updated as NonNullable<typeof updated>), created: false });
}

export async function upsertAssetType(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, MANAGE_ASSET_TYPES_ROLES);
  if (!auth.ok) return auth.response;

  const body = await readJsonBody(request);
  if (!body) return badRequest("Request body must be a JSON object");
  const parsed = parseAssetTypeInput(body);
  if (!parsed.ok) return badRequest(parsed.error);
  const input = parsed.value;

  const isUpdate = input.assetTypeId !== undefined;
  if (!isUpdate && (input.category === undefined || input.name === undefined)) {
    return badRequest("category and name are required");
  }

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const conn = connection;
    const outcome = await inTransaction(conn, () =>
      isUpdate ? updateAssetType(conn, input, auth.caller) : createAssetType(conn, input, auth.caller),
    );
    if (!outcome.ok) return outcome.response;
    return { jsonBody: outcome.value, status: 200 };
  } catch (error) {
    if (uniqueViolationName(error) !== null) {
      return conflict("An active asset type with that name already exists in this category");
    }
    context.error("upsertAssetType failed:", errorMessage(error));
    return errorResponse("Failed to save asset type", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("upsertAssetType", { authLevel: "anonymous", handler: upsertAssetType, methods: ["POST"] });
