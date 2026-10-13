// ─────────────────────────────────────────────────────────────────────────────
// Plumbing shared by the asset register handlers (WP49a): the auth prologue,
// JSON body reading, a transaction wrapper that supports early returns, the
// SELECT column lists, and the lookups several handlers need. The contract
// itself (roles, enums, validators, transforms) lives in ./assetRegister.
// ─────────────────────────────────────────────────────────────────────────────

import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { TYPES } from "tedious";
import type { Connection } from "tedious";
import {
  AppRole,
  extractToken,
  requireRole,
  unauthorizedResponse,
  verifiedIdentityFromRequest,
} from "./auth";
import {
  beginTransaction,
  commitTransaction,
  executeQuery,
  rollbackTransaction,
  type SqlRow,
} from "./db";

// ── SQL fragments ────────────────────────────────────────────────────────────
// Explicit column lists (no SELECT *) so a new column never leaks into a
// response by accident. Specs can be 16 KB per row, so lists leave it out.

export const ASSET_LIST_COLUMNS = `
  a.AssetId, a.BuildingId, a.LocationId, l.Name AS LocationName, a.ParentAssetId,
  a.AssetTag, a.Name, a.Category,
  a.AssetTypeId, t.Name AS AssetTypeName, a.AssetTypeNote,
  a.Make, a.Model, a.SerialNumber, a.InstallDate, a.WarrantyExpiry,
  a.Responsibility, a.Status, a.Criticality,
  a.ServiceContractorId, c.ContractorName AS ServiceContractorName,
  a.Notes, a.Source, a.ExternalId, a.VerifiedAt, a.VerifiedBy,
  a.CreatedAt, a.CreatedBy, a.UpdatedAt, a.UpdatedBy, a.ArchivedAt, a.ArchivedBy
`;

export const ASSET_DETAIL_COLUMNS = `${ASSET_LIST_COLUMNS}, a.Specs`;

export const ASSET_FROM = `
  FROM dbo.Assets a
  LEFT JOIN dbo.Locations l ON l.LocationId = a.LocationId
  LEFT JOIN dbo.AssetTypes t ON t.AssetTypeId = a.AssetTypeId
  LEFT JOIN dbo.Contractors c ON c.ContractorID = a.ServiceContractorId
`;

/** Same joins, with the asset row locked for the read-validate-write that follows. */
export const ASSET_FROM_FOR_UPDATE = `
  FROM dbo.Assets a WITH (UPDLOCK, ROWLOCK)
  LEFT JOIN dbo.Locations l ON l.LocationId = a.LocationId
  LEFT JOIN dbo.AssetTypes t ON t.AssetTypeId = a.AssetTypeId
  LEFT JOIN dbo.Contractors c ON c.ContractorID = a.ServiceContractorId
`;

export const LOCATION_COLUMNS = `
  l.LocationId, l.BuildingId, l.ParentLocationId, l.Kind, l.Name,
  l.SpaceType, l.SortOrder, l.Active
`;

export const ASSET_TYPE_COLUMNS = `
  t.AssetTypeId, t.Category, t.Name, t.Active, t.SortOrder
`;

// ── Responses ────────────────────────────────────────────────────────────────

export const badRequest = (error: string): HttpResponseInit => ({ jsonBody: { error }, status: 400 });
export const notFound = (error: string): HttpResponseInit => ({ jsonBody: { error }, status: 404 });
export const conflict = (error: string): HttpResponseInit => ({ jsonBody: { error }, status: 409 });

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Auth prologue ────────────────────────────────────────────────────────────

export interface Caller {
  name: string;
  oid: string;
}

export type AuthResult =
  | { ok: true; token: string }
  | { ok: false; response: HttpResponseInit };

export type WriteAuthResult =
  | { caller: Caller; ok: true; token: string }
  | { ok: false; response: HttpResponseInit };

/** Token present (401), role allowed (403, or 503 when the role lookup itself failed). */
export async function authorize(
  request: HttpRequest,
  roles: readonly AppRole[],
): Promise<AuthResult> {
  const token = extractToken(request);
  if (!token) return { ok: false, response: unauthorizedResponse() };
  const denied = await requireRole(request, roles);
  if (denied) return { ok: false, response: denied };
  return { ok: true, token };
}

/** As authorize, plus the signature-verified identity that audit columns are stamped from. */
export async function authorizeWrite(
  request: HttpRequest,
  roles: readonly AppRole[],
): Promise<WriteAuthResult> {
  const auth = await authorize(request, roles);
  if (!auth.ok) return auth;
  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return { ok: false, response: unauthorizedResponse() };
  return { caller: { name: identity.name, oid: identity.oid }, ok: true, token: auth.token };
}

/** The JSON body as an object, or null when it is missing, malformed, or not an object. */
export async function readJsonBody(request: HttpRequest): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// ── Transactions ─────────────────────────────────────────────────────────────

export type TxResult<T> = { ok: true; value: T } | { ok: false; response: HttpResponseInit };

export const txOk = <T>(value: T): TxResult<T> => ({ ok: true, value });
export const txFail = (response: HttpResponseInit): TxResult<never> => ({ ok: false, response });

/**
 * Runs `work` in a transaction. Returning txFail(...) rolls back and hands the
 * response to the caller (validation that must see a consistent snapshot);
 * throwing rolls back and rethrows.
 */
export async function inTransaction<T>(
  connection: Connection,
  work: () => Promise<TxResult<T>>,
): Promise<TxResult<T>> {
  await beginTransaction(connection);
  let result: TxResult<T>;
  try {
    result = await work();
  } catch (error) {
    await rollbackTransaction(connection).catch(() => undefined);
    throw error;
  }
  if (!result.ok) {
    await rollbackTransaction(connection).catch(() => undefined);
    return result;
  }
  try {
    await commitTransaction(connection);
  } catch (error) {
    await rollbackTransaction(connection).catch(() => undefined);
    throw error;
  }
  return result;
}

// ── Lookups ──────────────────────────────────────────────────────────────────

/** One asset with its joined display names. `forUpdate` locks the row for the rest of the transaction. */
export async function fetchAsset(
  connection: Connection,
  assetId: number,
  options: { forUpdate?: boolean } = {},
): Promise<SqlRow | null> {
  const params = [{ name: "AssetId", type: TYPES.Int, value: assetId }];
  const rows = options.forUpdate
    ? await executeQuery(
        connection,
        `SELECT ${ASSET_DETAIL_COLUMNS} ${ASSET_FROM_FOR_UPDATE} WHERE a.AssetId = @AssetId`,
        params,
      )
    : await executeQuery(
        connection,
        `SELECT ${ASSET_DETAIL_COLUMNS} ${ASSET_FROM} WHERE a.AssetId = @AssetId`,
        params,
      );
  return rows[0] ?? null;
}

export async function fetchLocation(
  connection: Connection,
  locationId: number,
  options: { forUpdate?: boolean } = {},
): Promise<SqlRow | null> {
  const params = [{ name: "LocationId", type: TYPES.Int, value: locationId }];
  const rows = options.forUpdate
    ? await executeQuery(
        connection,
        `SELECT ${LOCATION_COLUMNS} FROM dbo.Locations l WITH (UPDLOCK, ROWLOCK) WHERE l.LocationId = @LocationId`,
        params,
      )
    : await executeQuery(
        connection,
        `SELECT ${LOCATION_COLUMNS} FROM dbo.Locations l WHERE l.LocationId = @LocationId`,
        params,
      );
  return rows[0] ?? null;
}

export async function fetchAssetType(
  connection: Connection,
  assetTypeId: number,
  options: { forUpdate?: boolean } = {},
): Promise<SqlRow | null> {
  const params = [{ name: "AssetTypeId", type: TYPES.Int, value: assetTypeId }];
  const rows = options.forUpdate
    ? await executeQuery(
        connection,
        `SELECT ${ASSET_TYPE_COLUMNS} FROM dbo.AssetTypes t WITH (UPDLOCK, ROWLOCK) WHERE t.AssetTypeId = @AssetTypeId`,
        params,
      )
    : await executeQuery(
        connection,
        `SELECT ${ASSET_TYPE_COLUMNS} FROM dbo.AssetTypes t WHERE t.AssetTypeId = @AssetTypeId`,
        params,
      );
  return rows[0] ?? null;
}

/** Buildings are keyed on BuildingID (the upstream id, negative for manual buildings). */
export async function buildingExists(connection: Connection, buildingId: number): Promise<boolean> {
  const rows = await executeQuery(
    connection,
    `SELECT BuildingID FROM dbo.Buildings WHERE BuildingID = @BuildingId`,
    [{ name: "BuildingId", type: TYPES.Int, value: buildingId }],
  );
  return rows.length > 0;
}

/** True when making `newParentId` the parent of `locationId` would loop. */
export async function locationParentWouldCycle(
  connection: Connection,
  locationId: number,
  newParentId: number,
): Promise<boolean> {
  const rows = await executeQuery(
    connection,
    `WITH Ancestors AS (
       SELECT p.LocationId, p.ParentLocationId, 1 AS Depth
         FROM dbo.Locations p WHERE p.LocationId = @ParentId
       UNION ALL
       SELECT n.LocationId, n.ParentLocationId, x.Depth + 1
         FROM dbo.Locations n JOIN Ancestors x ON n.LocationId = x.ParentLocationId
        WHERE x.Depth < 50
     )
     SELECT TOP 1 LocationId FROM Ancestors WHERE LocationId = @LocationId`,
    [
      { name: "ParentId", type: TYPES.Int, value: newParentId },
      { name: "LocationId", type: TYPES.Int, value: locationId },
    ],
  );
  return rows.length > 0;
}

/** True when making `newParentId` the parent of `assetId` would loop. */
export async function assetParentWouldCycle(
  connection: Connection,
  assetId: number,
  newParentId: number,
): Promise<boolean> {
  const rows = await executeQuery(
    connection,
    `WITH Ancestors AS (
       SELECT p.AssetId, p.ParentAssetId, 1 AS Depth
         FROM dbo.Assets p WHERE p.AssetId = @ParentId
       UNION ALL
       SELECT n.AssetId, n.ParentAssetId, x.Depth + 1
         FROM dbo.Assets n JOIN Ancestors x ON n.AssetId = x.ParentAssetId
        WHERE x.Depth < 50
     )
     SELECT TOP 1 AssetId FROM Ancestors WHERE AssetId = @AssetId`,
    [
      { name: "ParentId", type: TYPES.Int, value: newParentId },
      { name: "AssetId", type: TYPES.Int, value: assetId },
    ],
  );
  return rows.length > 0;
}
