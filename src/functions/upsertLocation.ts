// POST /api/upsertLocation
//
// Body: LocationInput. Without locationId it creates (buildingId, kind, name
// required); with locationId it patches - omitted fields are left alone.
//   - a `level` is top-level and has no spaceType; a `space` may sit under the
//     building, a level, or another space of the SAME building (no cycles)
//   - buildingId and kind never change after creation
//   - a location with active sub-locations or live assets cannot be deactivated
//   - sortOrder defaults to the end of its siblings
// Response: { location, created }.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import type { Connection } from "tedious";
import { buildUpdateSet, closeConnection, createRequestConnection, executeQuery } from "../db";
import { errorResponse } from "../auth";
import {
  EDIT_ASSETS_ROLES,
  LocationApi,
  LocationInput,
  locationRowToApi,
  parseLocationInput,
  uniqueViolationName,
  validateLocationCreate,
} from "../assetRegister";
import {
  Caller,
  TxResult,
  authorizeWrite,
  badRequest,
  buildingExists,
  conflict,
  errorMessage,
  fetchLocation,
  inTransaction,
  locationParentWouldCycle,
  notFound,
  readJsonBody,
  txFail,
  txOk,
} from "../assetRegisterSupport";

interface UpsertLocationResult {
  created: boolean;
  location: LocationApi;
}

const LOCATION_UPDATE_COLUMNS = {
  Active: TYPES.Bit,
  Name: TYPES.NVarChar,
  ParentLocationId: TYPES.Int,
  SortOrder: TYPES.Int,
  SpaceType: TYPES.NVarChar,
};

/** Null when `parentId` is a legal parent for a location in `buildingId`; otherwise the rejection. */
async function checkParent(
  connection: Connection,
  parentId: number,
  buildingId: number,
  locationId?: number,
): Promise<HttpResponseInit | null> {
  if (locationId !== undefined && parentId === locationId) {
    return badRequest("A location cannot be its own parent");
  }
  const parent = await fetchLocation(connection, parentId);
  if (!parent) return badRequest("Unknown parent location");
  if (Number(parent.BuildingId) !== buildingId) {
    return badRequest("Parent location belongs to a different building");
  }
  if (!parent.Active) return badRequest("Parent location is inactive");
  if (locationId !== undefined && (await locationParentWouldCycle(connection, locationId, parentId))) {
    return badRequest("That parent would make the location its own ancestor");
  }
  return null;
}

async function createLocation(
  connection: Connection,
  input: LocationInput,
  caller: Caller,
): Promise<TxResult<UpsertLocationResult>> {
  const buildingId = input.buildingId as number;
  const kind = input.kind as string;
  const parentId = input.parentLocationId ?? null;

  if (!(await buildingExists(connection, buildingId))) return txFail(badRequest("Unknown building"));
  if (parentId !== null) {
    const rejected = await checkParent(connection, parentId, buildingId);
    if (rejected) return txFail(rejected);
  }

  const inserted = await executeQuery(
    connection,
    `INSERT INTO dbo.Locations
       (BuildingId, ParentLocationId, Kind, Name, SpaceType, SortOrder, Active, CreatedBy, UpdatedBy)
     OUTPUT INSERTED.LocationId
     VALUES (
       @BuildingId, @ParentLocationId, @Kind, @Name, @SpaceType,
       ISNULL(@SortOrder, (
         SELECT ISNULL(MAX(s.SortOrder), -1) + 1
           FROM dbo.Locations s
          WHERE s.BuildingId = @BuildingId
            AND s.Kind = @Kind
            AND ((s.ParentLocationId IS NULL AND @ParentLocationId IS NULL)
                 OR s.ParentLocationId = @ParentLocationId)
       )),
       @Active, @Caller, @Caller
     )`,
    [
      { name: "BuildingId", type: TYPES.Int, value: buildingId },
      { name: "ParentLocationId", type: TYPES.Int, value: parentId },
      { name: "Kind", type: TYPES.NVarChar, value: kind },
      { name: "Name", type: TYPES.NVarChar, value: input.name },
      { name: "SpaceType", type: TYPES.NVarChar, value: kind === "space" ? (input.spaceType ?? "other") : null },
      { name: "SortOrder", type: TYPES.Int, value: input.sortOrder ?? null },
      { name: "Active", type: TYPES.Bit, value: input.active ?? true },
      { name: "Caller", type: TYPES.NVarChar, value: caller.name },
    ],
  );
  const created = await fetchLocation(connection, inserted[0].LocationId as number);
  return txOk({ created: true, location: locationRowToApi(created as NonNullable<typeof created>) });
}

async function updateLocation(
  connection: Connection,
  input: LocationInput,
  caller: Caller,
): Promise<TxResult<UpsertLocationResult>> {
  const locationId = input.locationId as number;
  const current = await fetchLocation(connection, locationId, { forUpdate: true });
  if (!current) return txFail(notFound("Location not found"));

  const buildingId = Number(current.BuildingId);
  const kind = String(current.Kind);
  if (input.buildingId !== undefined && input.buildingId !== buildingId) {
    return txFail(badRequest("A location cannot move to a different building"));
  }
  if (input.kind !== undefined && input.kind !== kind) {
    return txFail(badRequest("A location's kind cannot be changed"));
  }
  if (kind === "level") {
    if (input.parentLocationId !== undefined && input.parentLocationId !== null) {
      return txFail(badRequest("A level cannot have a parent location"));
    }
    if (input.spaceType !== undefined && input.spaceType !== null) {
      return txFail(badRequest("spaceType only applies to spaces"));
    }
  }

  if (input.parentLocationId !== undefined && input.parentLocationId !== null) {
    const rejected = await checkParent(connection, input.parentLocationId, buildingId, locationId);
    if (rejected) return txFail(rejected);
  }

  if (input.active === false && current.Active) {
    const usage = await executeQuery(
      connection,
      `SELECT
         (SELECT COUNT(*) FROM dbo.Locations c WHERE c.ParentLocationId = @LocationId AND c.Active = 1) AS ChildCount,
         (SELECT COUNT(*) FROM dbo.Assets a WHERE a.LocationId = @LocationId AND a.ArchivedAt IS NULL) AS AssetCount`,
      [{ name: "LocationId", type: TYPES.Int, value: locationId }],
    );
    const children = Number(usage[0]?.ChildCount ?? 0);
    const assets = Number(usage[0]?.AssetCount ?? 0);
    if (children > 0 || assets > 0) {
      return txFail(
        conflict(
          `Cannot deactivate: it still has ${assets} asset(s) and ${children} active sub-location(s). Move or archive them first.`,
        ),
      );
    }
  }

  const update = buildUpdateSet(LOCATION_UPDATE_COLUMNS, {
    Active: input.active,
    Name: input.name,
    ParentLocationId: input.parentLocationId,
    SortOrder: input.sortOrder,
    // A space always has a type: clearing it resets to "other".
    SpaceType: kind === "space" && input.spaceType === null ? "other" : input.spaceType,
  });
  if (!update) return txFail(badRequest("No fields to update"));

  await executeQuery(
    connection,
    `UPDATE dbo.Locations
        SET ${update.setClause}, UpdatedAt = SYSUTCDATETIME(), UpdatedBy = @UpdatedBy
      WHERE LocationId = @LocationId`,
    [
      { name: "LocationId", type: TYPES.Int, value: locationId },
      { name: "UpdatedBy", type: TYPES.NVarChar, value: caller.name },
      ...update.params,
    ],
  );
  const updated = await fetchLocation(connection, locationId);
  return txOk({ created: false, location: locationRowToApi(updated as NonNullable<typeof updated>) });
}

export async function upsertLocation(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, EDIT_ASSETS_ROLES);
  if (!auth.ok) return auth.response;

  const body = await readJsonBody(request);
  if (!body) return badRequest("Request body must be a JSON object");
  const parsed = parseLocationInput(body);
  if (!parsed.ok) return badRequest(parsed.error);
  const input = parsed.value;

  const isUpdate = input.locationId !== undefined;
  if (!isUpdate) {
    const invalid = validateLocationCreate(input);
    if (invalid) return badRequest(invalid);
  }

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const conn = connection;
    const outcome = await inTransaction(conn, () =>
      isUpdate ? updateLocation(conn, input, auth.caller) : createLocation(conn, input, auth.caller),
    );
    if (!outcome.ok) return outcome.response;
    return { jsonBody: outcome.value, status: 200 };
  } catch (error) {
    if (uniqueViolationName(error) !== null) {
      return conflict("Another active location with that name already exists in the same place");
    }
    context.error("upsertLocation failed:", errorMessage(error));
    return errorResponse("Failed to save location", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("upsertLocation", { authLevel: "anonymous", handler: upsertLocation, methods: ["POST"] });
