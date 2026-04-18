import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { createConnection, executeQuery, closeConnection } from "../db";
import { fetchAllBuildings, MyBuilding } from "../mybuildings-client";
import { extractToken, unauthorizedResponse, errorResponse } from "../auth";
import { TYPES } from "tedious";

async function syncBuildings(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    context.log("Fetching buildings from myBuildings API...");
    const buildings = await fetchAllBuildings();
    context.log(`Fetched ${buildings.length} buildings from myBuildings`);

    context.log("Connecting to Azure SQL...");
    connection = await createConnection(token);

    let inserted = 0;
    let updated = 0;

    for (const building of buildings) {
      const existing = await executeQuery(
        connection,
        "SELECT Id FROM Buildings WHERE BuildingID = @BuildingID",
        [{ name: "BuildingID", type: TYPES.Int, value: building.BuildingID ?? null }]
      );

      if (existing.length > 0) {
        await executeQuery(connection,
          `UPDATE Buildings SET
            BuildingName=@BuildingName, BuildingCode=@BuildingCode,
            BuildingAddress=@BuildingAddress, ThirdPartySystem_BuildingID=@ThirdPartyBuildingID,
            RegionID=@RegionID, Region=@Region, NLA=@NLA,
            InvoicingAddress=@InvoicingAddress, ContactPhoneNumber=@ContactPhoneNumber,
            Levels=@Levels, Active=@Active, LastModifiedDate=@LastModifiedDate,
            LastSyncedAt=GETUTCDATE(), UpdatedAt=GETUTCDATE()
          WHERE BuildingID=@BuildingID`,
          buildingToParams(building)
        );
        updated++;
      } else {
        await executeQuery(connection,
          `INSERT INTO Buildings
            (BuildingID, BuildingName, BuildingCode, BuildingAddress,
             ThirdPartySystem_BuildingID, RegionID, Region, NLA, InvoicingAddress,
             ContactPhoneNumber, Levels, Active, LastModifiedDate,
             LastSyncedAt, CreatedAt, UpdatedAt)
          VALUES
            (@BuildingID, @BuildingName, @BuildingCode, @BuildingAddress,
             @ThirdPartyBuildingID, @RegionID, @Region, @NLA, @InvoicingAddress,
             @ContactPhoneNumber, @Levels, @Active, @LastModifiedDate,
             GETUTCDATE(), GETUTCDATE(), GETUTCDATE())`,
          buildingToParams(building)
        );
        inserted++;
      }
    }

    context.log(`Sync complete: ${inserted} inserted, ${updated} updated`);
    return { status: 200, jsonBody: { message: "Sync complete", total: buildings.length, inserted, updated } };
  } catch (error: any) {
    context.error("Sync failed:", error.message);
    return errorResponse("Sync failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

function buildingToParams(building: MyBuilding) {
  return [
    { name: "BuildingID", type: TYPES.Int, value: building.BuildingID ?? null },
    { name: "BuildingName", type: TYPES.NVarChar, value: building.BuildingName ?? null },
    { name: "BuildingCode", type: TYPES.NVarChar, value: building.BuildingCode ?? null },
    { name: "BuildingAddress", type: TYPES.NVarChar, value: building.BuildingAddress ?? null },
    { name: "ThirdPartyBuildingID", type: TYPES.NVarChar, value: building.ThirdPartySystem_BuildingID ?? null },
    { name: "RegionID", type: TYPES.Int, value: building.RegionID ?? null },
    { name: "Region", type: TYPES.NVarChar, value: building.Region ?? null },
    { name: "NLA", type: TYPES.NVarChar, value: building.NLA ?? null },
    { name: "InvoicingAddress", type: TYPES.NVarChar, value: building.InvoicingAddress ?? null },
    { name: "ContactPhoneNumber", type: TYPES.NVarChar, value: building.ContactPhoneNumber ?? null },
    { name: "Levels", type: TYPES.NVarChar, value: building.Levels ? JSON.stringify(building.Levels) : null },
    { name: "Active", type: TYPES.Bit, value: building.Active ?? true },
    { name: "LastModifiedDate", type: TYPES.NVarChar, value: building.LastModifiedDate ?? null },
  ];
}

app.http("syncBuildings", { methods: ["POST"], authLevel: "anonymous", handler: syncBuildings });
