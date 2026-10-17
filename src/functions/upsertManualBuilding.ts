// POST /api/upsertManualBuilding  (admin only)
//
// Body: { buildingId?, name, address?, category, ownerName? }. Without
// buildingId it creates a manual building (one not managed in myBuildings)
// under the next free negative id; with one it edits that manual building and
// leaves omitted fields alone (ownerName null clears the owner).
//   - category is 'commercial' or 'residence' (default 'commercial' on create)
//   - names are unique: work requests are matched to a building by name
//   - myBuildings buildings (positive ids) are never touched here; the sync owns them
// Response: { building, created }.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import type { Connection } from "tedious";
import { AppRole, errorResponse } from "../auth";
import { buildingCategoryColumnExists } from "../buildingCategoryColumn";
import { buildUpdateSet, closeConnection, createRequestConnection, executeQuery, type SqlRow } from "../db";
import {
  authorizeWrite,
  badRequest,
  conflict,
  errorMessage,
  inTransaction,
  notFound,
  readJsonBody,
  txFail,
  txOk,
  type Caller,
  type TxResult,
} from "../assetRegisterSupport";
import { parseManualBuildingInput, type ManualBuildingInput } from "../manualBuildingInput";
import { clearBuildingsCache } from "./getBuildings";

interface ManualBuildingApi {
  active: boolean;
  address: string;
  buildingId: number;
  category: string;
  name: string;
  ownerName: string | null;
}

interface UpsertManualBuildingResult {
  building: ManualBuildingApi;
  created: boolean;
}

const READ_COLUMNS = "BuildingID, BuildingName, BuildingAddress, Category, OwnerName, Active";
const READ_BUILDING = `SELECT ${READ_COLUMNS} FROM dbo.Buildings`;
const READ_BUILDING_LOCKED = `${READ_BUILDING} WITH (UPDLOCK, ROWLOCK)`;
const MANUAL_ID_ONLY = " WHERE BuildingID = @BuildingId AND BuildingID <= 0";

const UPDATE_COLUMNS = {
  BuildingAddress: TYPES.NVarChar,
  BuildingName: TYPES.NVarChar,
  Category: TYPES.NVarChar,
  OwnerName: TYPES.NVarChar,
};

function toApi(row: SqlRow): ManualBuildingApi {
  return {
    active: Boolean(row.Active),
    address: String(row.BuildingAddress ?? ""),
    buildingId: Number(row.BuildingID),
    category: String(row.Category ?? "commercial"),
    name: String(row.BuildingName ?? ""),
    ownerName: (row.OwnerName as string | null) ?? null,
  };
}

async function fetchBuilding(connection: Connection, buildingId: number, forUpdate = false): Promise<SqlRow | null> {
  const rows = await executeQuery(
    connection,
    (forUpdate ? READ_BUILDING_LOCKED : READ_BUILDING) + MANUAL_ID_ONLY,
    [{ name: "BuildingId", type: TYPES.Int, value: buildingId }],
  );
  return rows[0] ?? null;
}

async function nameTaken(connection: Connection, name: string, exceptId: number | null): Promise<boolean> {
  const rows = await executeQuery(
    connection,
    `SELECT BuildingID FROM dbo.Buildings WHERE BuildingName = @Name AND (@ExceptId IS NULL OR BuildingID <> @ExceptId)`,
    [
      { name: "Name", type: TYPES.NVarChar, value: name },
      { name: "ExceptId", type: TYPES.Int, value: exceptId },
    ],
  );
  return rows.length > 0;
}

const NAME_TAKEN = "Another building already has that name. Work requests are matched to a building by its name.";
const MIGRATION_PENDING = "Buildings cannot be edited until migration 136 is applied";

async function createBuilding(
  connection: Connection,
  input: ManualBuildingInput,
): Promise<TxResult<UpsertManualBuildingResult>> {
  const name = input.name;
  if (!name) return txFail(badRequest("name is required"));

  // Locked until commit so two admins adding at once cannot take the same id.
  // Taken before the name check: the second admin waits here, then sees the first one's row.
  const next = await executeQuery(
    connection,
    `SELECT ISNULL(MIN(BuildingID), 0) - 1 AS NextId FROM dbo.Buildings WITH (UPDLOCK, HOLDLOCK) WHERE BuildingID <= 0`,
  );
  const newId = Number(next[0]?.NextId ?? -1);
  if (await nameTaken(connection, name, null)) return txFail(conflict(NAME_TAKEN));

  await executeQuery(
    connection,
    `INSERT INTO dbo.Buildings (BuildingID, BuildingName, BuildingAddress, Category, OwnerName, Active, CreatedAt, UpdatedAt)
     VALUES (@NewId, @Name, @Address, @Category, @OwnerName, 1, GETUTCDATE(), GETUTCDATE())`,
    [
      { name: "NewId", type: TYPES.Int, value: newId },
      { name: "Name", type: TYPES.NVarChar, value: name },
      { name: "Address", type: TYPES.NVarChar, value: input.address ?? name },
      { name: "Category", type: TYPES.NVarChar, value: input.category ?? "commercial" },
      { name: "OwnerName", type: TYPES.NVarChar, value: input.ownerName ?? null },
    ],
  );
  const created = await fetchBuilding(connection, newId);
  return txOk({ building: toApi(created as SqlRow), created: true });
}

async function updateBuilding(
  connection: Connection,
  input: ManualBuildingInput,
): Promise<TxResult<UpsertManualBuildingResult>> {
  const buildingId = input.buildingId as number;
  const current = await fetchBuilding(connection, buildingId, true);
  if (!current) return txFail(notFound("Manual building not found"));

  const update = buildUpdateSet(UPDATE_COLUMNS, {
    BuildingAddress: input.address,
    BuildingName: input.name,
    Category: input.category,
    OwnerName: input.ownerName,
  });
  if (!update) return txFail(badRequest("Nothing to change"));
  if (input.name !== undefined && (await nameTaken(connection, input.name, buildingId))) {
    return txFail(conflict(NAME_TAKEN));
  }

  await executeQuery(
    connection,
    `UPDATE dbo.Buildings SET ${update.setClause}, UpdatedAt = GETUTCDATE()
      WHERE BuildingID = @BuildingId AND BuildingID <= 0`,
    [{ name: "BuildingId", type: TYPES.Int, value: buildingId }, ...update.params],
  );
  const updated = await fetchBuilding(connection, buildingId);
  return txOk({ building: toApi(updated as SqlRow), created: false });
}

export async function upsertManualBuilding(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, [AppRole.ADMIN]);
  if (!auth.ok) return auth.response;

  const body = await readJsonBody(request);
  if (!body) return badRequest("Request body must be a JSON object");
  const parsed = parseManualBuildingInput(body);
  if (!parsed.ok) return badRequest(parsed.error);
  const input = parsed.value;
  const isUpdate = input.buildingId !== undefined;
  if (!isUpdate && !input.name) return badRequest("name is required");

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const conn = connection;
    if (!(await buildingCategoryColumnExists(conn))) return conflict(MIGRATION_PENDING);
    const outcome = await inTransaction(conn, () => (isUpdate ? updateBuilding(conn, input) : createBuilding(conn, input)));
    if (!outcome.ok) return outcome.response;

    clearBuildingsCache();
    const { building, created } = outcome.value;
    logAudit(context, auth.caller, building, created);
    return { jsonBody: outcome.value, status: 200 };
  } catch (error) {
    context.error("upsertManualBuilding failed:", errorMessage(error));
    return errorResponse("Failed to save building", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// Who changed which building to what. Never the row's other fields.
function logAudit(context: InvocationContext, caller: Caller, building: ManualBuildingApi, created: boolean): void {
  context.log(
    `upsertManualBuilding: ${caller.name} ${created ? "created" : "updated"} building ${building.buildingId} ` +
      `(category=${building.category}, owner=${building.ownerName ?? "none"})`,
  );
}

app.http("upsertManualBuilding", { authLevel: "anonymous", handler: upsertManualBuilding, methods: ["POST"] });
