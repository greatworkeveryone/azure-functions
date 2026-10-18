import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { AppRole, errorResponse, unauthorizedResponse } from "./auth";
import { beginTransaction, closeConnection, commitTransaction, createRequestConnection, executeQuery, rollbackTransaction } from "./db";
import { record } from "./ledger";
import { resolveLedgerActor } from "./ledger/actor";
import { invalidateTenantAndBuilding } from "./tenant-register-cache";

// A tenancy's areas (TenantOccupancies) and car parks (Carparks) are archived,
// never hard-deleted (D10; database-safety rule 1; migration 140). Archive
// stamps who, when and why; restore clears it; each is ledgered with its
// reason in the same transaction. The roles are those that held the old
// deleteOccupancy / deleteCarpark (cfo through requireRole's hierarchy); the
// frontend's archiveTenancyParts capability mirrors them.

export const TENANCY_PART_ARCHIVE_ROLES = [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR] as const;

export type TenancyPartKind = "carpark" | "occupancy";

interface PartSql {
  archive: string;
  idField: "CarparkId" | "OccupancyId";
  noun: string;
  read: string;
  restore: string;
}

const PARTS: Record<TenancyPartKind, PartSql> = {
  carpark: {
    archive: `UPDATE dbo.Carparks SET ArchivedAt = SYSUTCDATETIME(), ArchivedBy = @By, ArchiveReason = @Reason
 WHERE CarparkId = @Id AND ArchivedAt IS NULL`,
    idField: "CarparkId",
    noun: "Car park",
    read: `SELECT c.TenantId, c.BuildingId, c.ArchivedAt, c.Identifier AS Label
  FROM dbo.Carparks c WITH (UPDLOCK, HOLDLOCK)
 WHERE c.CarparkId = @Id`,
    restore: `UPDATE dbo.Carparks SET ArchivedAt = NULL, ArchivedBy = NULL, ArchiveReason = NULL
 WHERE CarparkId = @Id AND ArchivedAt IS NOT NULL`,
  },
  occupancy: {
    archive: `UPDATE dbo.TenantOccupancies SET ArchivedAt = SYSUTCDATETIME(), ArchivedBy = @By, ArchiveReason = @Reason
 WHERE OccupancyId = @Id AND ArchivedAt IS NULL`,
    idField: "OccupancyId",
    noun: "Area",
    read: `SELECT o.TenantId, o.BuildingId, o.ArchivedAt, CONCAT(o.Level, N' / ', o.Area) AS Label
  FROM dbo.TenantOccupancies o WITH (UPDLOCK, HOLDLOCK)
 WHERE o.OccupancyId = @Id`,
    restore: `UPDATE dbo.TenantOccupancies SET ArchivedAt = NULL, ArchivedBy = NULL, ArchiveReason = NULL
 WHERE OccupancyId = @Id AND ArchivedAt IS NOT NULL`,
  },
};

/** Archive (or restore) one area or car park, after the route's role check. Body { OccupancyId | CarparkId, Reason }. */
export async function setTenancyPartArchived(
  request: HttpRequest,
  context: InvocationContext,
  token: string,
  kind: TenancyPartKind,
  archive: boolean,
): Promise<HttpResponseInit> {
  const sql = PARTS[kind];
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const id = body?.[sql.idField];
  const reason = typeof body?.Reason === "string" ? body.Reason.trim() : "";
  if (typeof id !== "string" || !id) return { status: 400, jsonBody: { error: `${sql.idField} required` } };
  if (!reason) return { status: 400, jsonBody: { error: "A reason is required" } };
  if (reason.length > 2000) return { status: 400, jsonBody: { error: "Reason must be 2000 characters or fewer" } };

  let connection;
  try {
    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();
    const idParam = { name: "Id", type: TYPES.NVarChar, value: id };

    let scope: { buildingId: number; tenantId: number | null };
    await beginTransaction(connection);
    try {
      const [row] = await executeQuery(connection, sql.read, [idParam]);
      if (!row) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: `${sql.noun} not found` } };
      }
      const label = String(row.Label ?? id);
      const archived = row.ArchivedAt !== null && row.ArchivedAt !== undefined;
      if (archived === archive) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 409, jsonBody: { error: `${sql.noun} ${label} is ${archive ? "already archived" : "not archived"}.` } };
      }
      scope = { buildingId: row.BuildingId as number, tenantId: (row.TenantId as number | null) ?? null };
      await executeQuery(
        connection,
        archive ? sql.archive : sql.restore,
        archive
          ? [idParam, { name: "By", type: TYPES.NVarChar, value: actor.name }, { name: "Reason", type: TYPES.NVarChar, value: reason }]
          : [idParam],
      );
      await record(connection, {
        action: archive ? `${kind}.archive` : `${kind}.unarchive`,
        actor,
        buildingId: scope.buildingId,
        reason,
        subject: { id, type: kind },
        tenantId: scope.tenantId,
      });
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }
    if (scope.tenantId !== null) invalidateTenantAndBuilding(scope.tenantId, scope.buildingId);
    return { status: 200, jsonBody: { archived: archive, id, kind } };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error(`${archive ? "archive" : "unarchive"} ${kind} failed:`, message);
    return errorResponse(archive ? `Archive ${kind} failed` : `Restore ${kind} failed`, message);
  } finally {
    if (connection) closeConnection(connection);
  }
}
