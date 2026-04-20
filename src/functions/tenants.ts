// Tenants — the party that occupies one or more levels of a building.
// Jobs can be assigned to a tenant so on-charge flows know who to recoup
// from. Minimal CRUD for now; a myBuildings sync endpoint can plug into
// the same shape when that comes online.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { buildUpdateSet, createConnection, executeQuery, closeConnection } from "../db";
import { extractToken, unauthorizedResponse, errorResponse } from "../auth";

const TENANT_COLUMNS = `
  TenantID, ThirdPartyTenantID, TenantName, BuildingID, Levels,
  CreatedAt, UpdatedAt
`;

// ── GET /api/getTenants[?buildingId=N][&tenantId=N] ─────────────────────────

async function getTenants(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const buildingId = request.query.get("buildingId");
  const tenantId = request.query.get("tenantId");

  const whereParts: string[] = [];
  const params: { name: string; type: any; value: any }[] = [];
  if (buildingId) {
    whereParts.push("BuildingID = @BuildingID");
    params.push({ name: "BuildingID", type: TYPES.Int, value: Number(buildingId) });
  }
  if (tenantId) {
    whereParts.push("TenantID = @TenantID");
    params.push({ name: "TenantID", type: TYPES.Int, value: Number(tenantId) });
  }
  const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

  let connection;
  try {
    connection = await createConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT ${TENANT_COLUMNS} FROM Tenants ${where} ORDER BY TenantName`,
      params,
    );
    return { status: 200, jsonBody: { count: rows.length, tenants: rows } };
  } catch (error: any) {
    context.error("getTenants failed:", error.message);
    return errorResponse("Failed to fetch tenants", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/upsertTenant ──────────────────────────────────────────────────
// Body: {
//   TenantID?, ThirdPartyTenantID?, TenantName (required on create),
//   BuildingID (required on create), Levels? (string[] → JSON-encoded)
// }
// Levels is accepted as either a string[] or a pre-serialised JSON string;
// the endpoint normalises to a JSON array before writing so the DB column
// always parses cleanly with OPENJSON.

async function upsertTenant(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const {
      TenantID,
      ThirdPartyTenantID,
      TenantName,
      BuildingID,
      Levels,
    } = body ?? {};

    const levelsJson = normaliseLevels(Levels);

    connection = await createConnection(token);

    if (TenantID === undefined) {
      // Create
      if (typeof TenantName !== "string" || !TenantName.trim()) {
        return { status: 400, jsonBody: { error: "TenantName (string) required" } };
      }
      if (typeof BuildingID !== "number") {
        return { status: 400, jsonBody: { error: "BuildingID (number) required" } };
      }
      const inserted = await executeQuery(
        connection,
        `INSERT INTO Tenants
           (ThirdPartyTenantID, TenantName, BuildingID, Levels)
         OUTPUT INSERTED.TenantID
         VALUES (@ThirdPartyTenantID, @TenantName, @BuildingID, @Levels);`,
        [
          { name: "ThirdPartyTenantID", type: TYPES.NVarChar, value: ThirdPartyTenantID ?? null },
          { name: "TenantName", type: TYPES.NVarChar, value: TenantName },
          { name: "BuildingID", type: TYPES.Int, value: BuildingID },
          { name: "Levels", type: TYPES.NVarChar, value: levelsJson },
        ],
      );
      const newId = inserted[0].TenantID as number;
      const stored = await executeQuery(
        connection,
        `SELECT ${TENANT_COLUMNS} FROM Tenants WHERE TenantID = @Id`,
        [{ name: "Id", type: TYPES.Int, value: newId }],
      );
      return { status: 200, jsonBody: { tenant: stored[0] } };
    }

    // Update
    if (typeof TenantID !== "number") {
      return { status: 400, jsonBody: { error: "TenantID must be a number" } };
    }
    const update = buildUpdateSet(
      {
        BuildingID: TYPES.Int,
        Levels: TYPES.NVarChar,
        TenantName: TYPES.NVarChar,
        ThirdPartyTenantID: TYPES.NVarChar,
      },
      {
        BuildingID,
        // Levels is stored as JSON — pass the serialized string, not the array.
        Levels: Levels === undefined ? undefined : levelsJson,
        TenantName,
        ThirdPartyTenantID,
      },
    );
    // UpdatedAt is always bumped — SQL expression, outside the allowlist.
    const setClause = update
      ? `${update.setClause}, UpdatedAt = SYSUTCDATETIME()`
      : "UpdatedAt = SYSUTCDATETIME()";

    await executeQuery(
      connection,
      `UPDATE Tenants SET ${setClause} WHERE TenantID = @Id`,
      [
        { name: "Id", type: TYPES.Int, value: TenantID },
        ...(update?.params ?? []),
      ],
    );
    const stored = await executeQuery(
      connection,
      `SELECT ${TENANT_COLUMNS} FROM Tenants WHERE TenantID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: TenantID }],
    );
    if (stored.length === 0) {
      return { status: 404, jsonBody: { error: "Tenant not found" } };
    }
    return { status: 200, jsonBody: { tenant: stored[0] } };
  } catch (error: any) {
    context.error("upsertTenant failed:", error.message);
    return errorResponse("Upsert tenant failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/deleteTenant ──────────────────────────────────────────────────
// Refuses when the tenant is linked to any job — the user should reassign
// those jobs first. FK_Jobs_Tenants doesn't cascade, so a raw DELETE would
// fail with a foreign-key error anyway; this check produces a clean message.

async function deleteTenant(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const { TenantID } = body ?? {};
    if (typeof TenantID !== "number") {
      return { status: 400, jsonBody: { error: "TenantID (number) required" } };
    }

    connection = await createConnection(token);
    const refCount = await executeQuery(
      connection,
      "SELECT COUNT(*) AS N FROM Jobs WHERE TenantID = @Id",
      [{ name: "Id", type: TYPES.Int, value: TenantID }],
    );
    if ((refCount[0]?.N as number) > 0) {
      return {
        status: 400,
        jsonBody: {
          error: "Cannot delete — tenant is assigned to at least one job. Reassign first.",
        },
      };
    }

    await executeQuery(
      connection,
      "DELETE FROM Tenants WHERE TenantID = @Id",
      [{ name: "Id", type: TYPES.Int, value: TenantID }],
    );

    return { status: 200, jsonBody: { deleted: true, tenantId: TenantID } };
  } catch (error: any) {
    context.error("deleteTenant failed:", error.message);
    return errorResponse("Delete tenant failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

/** Accepts a string[] or a pre-serialised JSON string, returns the JSON
 *  array string to store in Tenants.Levels. Empty / undefined → null. */
function normaliseLevels(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (Array.isArray(input)) {
    const cleaned = input
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .map((s) => s.trim());
    return cleaned.length > 0 ? JSON.stringify(cleaned) : null;
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return normaliseLevels(parsed);
    } catch {
      // Fall through — treat as a single-level string.
    }
    return JSON.stringify([trimmed]);
  }
  return null;
}

app.http("getTenants", { methods: ["GET"], authLevel: "anonymous", handler: getTenants });
app.http("upsertTenant", { methods: ["POST"], authLevel: "anonymous", handler: upsertTenant });
app.http("deleteTenant", { methods: ["POST"], authLevel: "anonymous", handler: deleteTenant });
