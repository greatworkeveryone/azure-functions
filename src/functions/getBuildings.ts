import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { createConnection, executeQuery, closeConnection } from "../db";
import { extractToken, unauthorizedResponse, errorResponse } from "../auth";
import { TYPES } from "tedious";

async function getBuildings(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    connection = await createConnection(token);

    const buildingId = request.query.get("buildingId");
    const region = request.query.get("region");

    let sql = "SELECT * FROM Buildings WHERE 1=1";
    const params: { name: string; type: any; value: any }[] = [];

    if (buildingId) {
      sql += " AND BuildingID = @BuildingID";
      params.push({ name: "BuildingID", type: TYPES.Int, value: parseInt(buildingId) });
    }
    if (region) {
      sql += " AND Region = @Region";
      params.push({ name: "Region", type: TYPES.NVarChar, value: region });
    }

    sql += " ORDER BY BuildingName";
    const rows = await executeQuery(connection, sql, params);

    return { status: 200, jsonBody: { buildings: rows, count: rows.length } };
  } catch (error: any) {
    context.error("Query failed:", error.message);
    return errorResponse("Query failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getBuildings", { methods: ["GET"], authLevel: "anonymous", handler: getBuildings });
