// Legacy Tenants endpoints — kept for the keys/jobs flows that tag work with
// a tenant. After migration 037 the schema is now the rich register, so this
// file projects the new columns down to the old shape:
//
//   LegalName             → TenantName
//   MyobId                → ThirdPartyTenantID  (closest equivalent)
//   distinct occupancy levels → Levels (JSON array)
//
// New code should use `tenancy.ts` (getRegisterTenants / upsertRegisterTenant).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { closeConnection, createConnection, executeQuery } from "../db";
import { errorResponse, extractToken, oidFromToken, unauthorizedResponse } from "../auth";

interface CallerRef { id: string; name: string }

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function callerFromToken(token: string): CallerRef {
  const claims = decodeJwtPayload(token);
  const id = oidFromToken(token) ?? (claims?.preferred_username as string) ?? "unknown";
  const name =
    (claims?.name as string) ?? (claims?.preferred_username as string) ?? "Unknown user";
  return { id, name };
}

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
    whereParts.push("t.BuildingId = @BuildingId");
    params.push({ name: "BuildingId", type: TYPES.Int, value: Number(buildingId) });
  }
  if (tenantId) {
    whereParts.push("t.TenantId = @TenantId");
    params.push({ name: "TenantId", type: TYPES.Int, value: Number(tenantId) });
  }
  const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

  let connection;
  try {
    connection = await createConnection(token);
    // Project new schema to the legacy shape jobs/keys still consume. Levels
    // is derived from the distinct levels in TenantOccupancies.
    const rows = await executeQuery(
      connection,
      `SELECT
         t.TenantId            AS TenantID,
         t.MyobId              AS ThirdPartyTenantID,
         t.LegalName           AS TenantName,
         t.BuildingId          AS BuildingID,
         (
           SELECT '[' + STRING_AGG('"' + STRING_ESCAPE(o.Level, 'json') + '"', ',') + ']'
           FROM (SELECT DISTINCT Level FROM dbo.TenantOccupancies WHERE TenantId = t.TenantId) o
         ) AS Levels,
         t.CreatedAt,
         t.UpdatedAt
       FROM dbo.Tenants t
       ${where}
       ORDER BY t.LegalName`,
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
// Body: { TenantID?, ThirdPartyTenantID?, TenantName, BuildingID, Levels? }
// Levels[] is accepted but ignored — the new schema models occupancy via
// TenantOccupancies, which the keys/jobs flows don't write to. The register
// UI is the canonical place to manage levels + areas.

async function upsertTenant(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const caller = callerFromToken(token);

  let connection;
  try {
    const body = (await request.json()) as any;
    const { TenantID, ThirdPartyTenantID, TenantName, BuildingID } = body ?? {};

    connection = await createConnection(token);

    if (TenantID === undefined) {
      // Create — minimum viable register tenant. Defaults match the schema.
      if (typeof TenantName !== "string" || !TenantName.trim()) {
        return { status: 400, jsonBody: { error: "TenantName (string) required" } };
      }
      if (typeof BuildingID !== "number") {
        return { status: 400, jsonBody: { error: "BuildingID (number) required" } };
      }
      const inserted = await executeQuery(
        connection,
        `INSERT INTO dbo.Tenants (
            BuildingId, LegalName, MyobId, RentBasis, ReviewType, Status,
            CreatedById, CreatedByName, UpdatedById, UpdatedByName
         )
         OUTPUT INSERTED.TenantId
         VALUES (@BuildingId, @LegalName, @MyobId, 'fixedAnnual', 'none', 'current',
                 @CreatedById, @CreatedByName, @UpdatedById, @UpdatedByName)`,
        [
          { name: "BuildingId", type: TYPES.Int, value: BuildingID },
          { name: "LegalName", type: TYPES.NVarChar, value: TenantName.trim() },
          { name: "MyobId", type: TYPES.NVarChar, value: ThirdPartyTenantID ?? null },
          { name: "CreatedById", type: TYPES.NVarChar, value: caller.id },
          { name: "CreatedByName", type: TYPES.NVarChar, value: caller.name },
          { name: "UpdatedById", type: TYPES.NVarChar, value: caller.id },
          { name: "UpdatedByName", type: TYPES.NVarChar, value: caller.name },
        ],
      );
      const newId = inserted[0].TenantId as number;
      return { status: 200, jsonBody: { tenant: await loadLegacyTenant(connection, newId) } };
    }

    // Update — only the legacy-mappable fields are touched. Levels is ignored.
    if (typeof TenantID !== "number") {
      return { status: 400, jsonBody: { error: "TenantID must be a number" } };
    }
    const setParts: string[] = ["UpdatedAt = SYSUTCDATETIME()", "UpdatedById = @UpdatedById", "UpdatedByName = @UpdatedByName"];
    const updateParams: { name: string; type: any; value: any }[] = [
      { name: "Id", type: TYPES.Int, value: TenantID },
      { name: "UpdatedById", type: TYPES.NVarChar, value: caller.id },
      { name: "UpdatedByName", type: TYPES.NVarChar, value: caller.name },
    ];
    if (typeof TenantName === "string" && TenantName.trim()) {
      setParts.push("LegalName = @LegalName");
      updateParams.push({ name: "LegalName", type: TYPES.NVarChar, value: TenantName.trim() });
    }
    if (ThirdPartyTenantID !== undefined) {
      setParts.push("MyobId = @MyobId");
      updateParams.push({ name: "MyobId", type: TYPES.NVarChar, value: ThirdPartyTenantID });
    }
    if (typeof BuildingID === "number") {
      setParts.push("BuildingId = @BuildingId");
      updateParams.push({ name: "BuildingId", type: TYPES.Int, value: BuildingID });
    }

    await executeQuery(
      connection,
      `UPDATE dbo.Tenants SET ${setParts.join(", ")} WHERE TenantId = @Id`,
      updateParams,
    );
    const stored = await loadLegacyTenant(connection, TenantID);
    if (!stored) {
      return { status: 404, jsonBody: { error: "Tenant not found" } };
    }
    return { status: 200, jsonBody: { tenant: stored } };
  } catch (error: any) {
    context.error("upsertTenant failed:", error.message);
    return errorResponse("Upsert tenant failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

async function loadLegacyTenant(connection: any, id: number) {
  const rows = await executeQuery(
    connection,
    `SELECT
       t.TenantId            AS TenantID,
       t.MyobId              AS ThirdPartyTenantID,
       t.LegalName           AS TenantName,
       t.BuildingId          AS BuildingID,
       (
         SELECT '[' + STRING_AGG('"' + STRING_ESCAPE(o.Level, 'json') + '"', ',') + ']'
         FROM (SELECT DISTINCT Level FROM dbo.TenantOccupancies WHERE TenantId = t.TenantId) o
       ) AS Levels,
       t.CreatedAt,
       t.UpdatedAt
     FROM dbo.Tenants t
     WHERE t.TenantId = @Id`,
    [{ name: "Id", type: TYPES.Int, value: id }],
  );
  return rows[0] ?? null;
}

// ── POST /api/deleteTenant ──────────────────────────────────────────────────
// Refuses when the tenant is linked to any job. ON DELETE CASCADE handles
// occupancies/notes/history/reviews under the new schema.

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
      "SELECT COUNT(*) AS N FROM dbo.Jobs WHERE TenantID = @Id",
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
      "DELETE FROM dbo.Tenants WHERE TenantId = @Id",
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

app.http("getTenants",   { methods: ["GET"],  authLevel: "anonymous", handler: getTenants });
app.http("upsertTenant", { methods: ["POST"], authLevel: "anonymous", handler: upsertTenant });
app.http("deleteTenant", { methods: ["POST"], authLevel: "anonymous", handler: deleteTenant });
