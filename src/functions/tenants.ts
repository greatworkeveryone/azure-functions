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
import { closeConnection, createRequestConnection, executeQuery } from "../db";
import { deleteTenancyDraft, TENANCY_DELETE_ROLES } from "../tenancy-records";
import { AppRole, errorResponse, extractToken, oidFromToken, requireRole, unauthorizedResponse } from "../auth";
import { invalidateTenant, invalidateTenantAndBuilding } from "../tenant-register-cache";
import { showTestParam, testFlagForCreate } from "../test-data";

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
  const roleCheck = await requireRole(request, [AppRole.ACCOUNTS, AppRole.ADMIN, AppRole.DIRECTOR, AppRole.FACILITIES]);
  if (roleCheck) return roleCheck;

  const buildingId = request.query.get("buildingId");
  const tenantId = request.query.get("tenantId");

  // Archived tenancies (D4) stay out of the pickers jobs and keys use.
  const whereParts: string[] = ["t.ArchivedAt IS NULL"];
  const params: { name: string; type: any; value: any }[] = [];
  if (buildingId) {
    whereParts.push("t.BuildingId = @BuildingId");
    params.push({ name: "BuildingId", type: TYPES.Int, value: Number(buildingId) });
  }
  if (tenantId) {
    whereParts.push("t.TenantId = @TenantId");
    params.push({ name: "TenantId", type: TYPES.Int, value: Number(tenantId) });
  }
  // Test tenancies (D9) only with the admin's Show test data on.
  whereParts.push("(t.IsTest = 0 OR @ShowTest = 1)");
  params.push(await showTestParam(request));
  const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

  let connection;
  try {
    connection = await createRequestConnection(token);
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
  const roleCheck = await requireRole(request, [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR]);
  if (roleCheck) return roleCheck;
  const caller = callerFromToken(token);

  let connection;
  try {
    const body = (await request.json()) as any;
    const { TenantID, ThirdPartyTenantID, TenantName, BuildingID } = body ?? {};

    connection = await createRequestConnection(token);

    if (TenantID === undefined) {
      // Create — minimum viable register tenant. Defaults match the schema.
      if (typeof TenantName !== "string" || !TenantName.trim()) {
        return { status: 400, jsonBody: { error: "TenantName (string) required" } };
      }
      if (typeof BuildingID !== "number") {
        return { status: 400, jsonBody: { error: "BuildingID (number) required" } };
      }
      // D9: admins and directors may create a test tenancy; an admin's "[TEST]" name does too.
      const testFlag = await testFlagForCreate(request, body?.IsTest, TenantName);
      if ("error" in testFlag) return testFlag.error;
      const inserted = await executeQuery(
        connection,
        `INSERT INTO dbo.Tenants (
            BuildingId, LegalName, MyobId, RentBasis, ReviewType, Status,
            CreatedById, CreatedByName, UpdatedById, UpdatedByName, IsTest
         )
         OUTPUT INSERTED.TenantId
         VALUES (@BuildingId, @LegalName, @MyobId, 'fixedAnnual', 'none', 'current',
                 @CreatedById, @CreatedByName, @UpdatedById, @UpdatedByName, @IsTest)`,
        [
          { name: "IsTest", type: TYPES.Bit, value: testFlag.isTest },
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
      invalidateTenantAndBuilding(newId, BuildingID);
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
    if (typeof BuildingID === "number") {
      invalidateTenantAndBuilding(TenantID, BuildingID);
    } else {
      invalidateTenant(TenantID);
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
// Body { TenantID }. The older route to the same rule as deleteRegisterTenant
// (D4): same roles, and only an empty draft is deleted, by deleteTenancyDraft.

async function deleteTenant(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, TENANCY_DELETE_ROLES);
  if (roleCheck) return roleCheck;

  const body = (await request.json().catch(() => null)) as { TenantID?: unknown } | null;
  const tenantId = body?.TenantID;
  if (typeof tenantId !== "number") {
    return { status: 400, jsonBody: { error: "TenantID (number) required" } };
  }
  return deleteTenancyDraft(request, context, token, tenantId, "deleteTenant");
}

app.http("getTenants",   { methods: ["GET"],  authLevel: "anonymous", handler: getTenants });
app.http("upsertTenant", { methods: ["POST"], authLevel: "anonymous", handler: upsertTenant });
app.http("deleteTenant", { methods: ["POST"], authLevel: "anonymous", handler: deleteTenant });
