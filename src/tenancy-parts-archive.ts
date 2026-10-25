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
// reason in the same transaction. Who may: the roles table's archiveTenancyParts
// (action-roles.ts), which the frontend reads as its capability.

export type TenancyPartKind = "carpark" | "occupancy";

interface PartSql {
  archive: string;
  idField: "CarparkId" | "OccupancyId";
  idsField: "CarparkIds" | "OccupancyIds";
  noun: string;
  read: string;
  restore: string;
}

const PARTS: Record<TenancyPartKind, PartSql> = {
  carpark: {
    archive: `UPDATE dbo.Carparks SET ArchivedAt = SYSUTCDATETIME(), ArchivedBy = @By, ArchiveReason = @Reason
 WHERE CarparkId = @Id AND ArchivedAt IS NULL`,
    idField: "CarparkId",
    idsField: "CarparkIds",
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
    idsField: "OccupancyIds",
    noun: "Area",
    read: `SELECT o.TenantId, o.BuildingId, o.ArchivedAt, CONCAT(o.Level, N' / ', o.Area) AS Label
  FROM dbo.TenantOccupancies o WITH (UPDLOCK, HOLDLOCK)
 WHERE o.OccupancyId = @Id`,
    restore: `UPDATE dbo.TenantOccupancies SET ArchivedAt = NULL, ArchivedBy = NULL, ArchiveReason = NULL
 WHERE OccupancyId = @Id AND ArchivedAt IS NOT NULL`,
  },
};

/** Most parts one call may archive or restore (the Edit tenancy modal's removals). */
export const MAX_PARTS_PER_CALL = 50;

/** The ids a body names: one (`OccupancyId`) or several (`OccupancyIds`, all or none), or why not. */
function idsOf(body: Record<string, unknown> | null, sql: PartSql): string[] | { error: string } {
  const many = body?.[sql.idsField];
  if (many === undefined) {
    const one = body?.[sql.idField];
    return typeof one === "string" && one ? [one] : { error: `${sql.idField} required` };
  }
  if (!Array.isArray(many) || many.length === 0 || many.length > MAX_PARTS_PER_CALL) {
    return { error: `${sql.idsField} must list 1 to ${MAX_PARTS_PER_CALL} ids` };
  }
  const ids = many.filter((id): id is string => typeof id === "string" && id !== "");
  if (ids.length !== many.length || new Set(ids).size !== ids.length) return { error: `${sql.idsField} must be distinct ids` };
  return ids;
}

/**
 * Archive (or restore) one area or car park, or several in one transaction,
 * after the route's role check. Body { OccupancyId | OccupancyIds | CarparkId |
 * CarparkIds, Reason }. Every row is read under lock before any is written, so
 * one missing or already-archived row leaves all of them as they were.
 */
export async function setTenancyPartArchived(
  request: HttpRequest,
  context: InvocationContext,
  token: string,
  kind: TenancyPartKind,
  archive: boolean,
): Promise<HttpResponseInit> {
  const sql = PARTS[kind];
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const ids = idsOf(body, sql);
  const reason = typeof body?.Reason === "string" ? body.Reason.trim() : "";
  if (!Array.isArray(ids)) return { status: 400, jsonBody: ids };
  if (!reason) return { status: 400, jsonBody: { error: "A reason is required" } };
  if (reason.length > 2000) return { status: 400, jsonBody: { error: "Reason must be 2000 characters or fewer" } };

  let connection;
  try {
    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();
    const idParam = (id: string) => ({ name: "Id", type: TYPES.NVarChar, value: id });

    const scopes: { buildingId: number; id: string; tenantId: number | null }[] = [];
    await beginTransaction(connection);
    try {
      for (const id of ids) {
        const [row] = await executeQuery(connection, sql.read, [idParam(id)]);
        if (!row) {
          await rollbackTransaction(connection).catch(() => {});
          return { status: 404, jsonBody: { error: `${sql.noun} not found` } };
        }
        const archived = row.ArchivedAt !== null && row.ArchivedAt !== undefined;
        if (archived === archive) {
          await rollbackTransaction(connection).catch(() => {});
          const label = String(row.Label ?? id);
          return { status: 409, jsonBody: { error: `${sql.noun} ${label} is ${archive ? "already archived" : "not archived"}.` } };
        }
        scopes.push({ buildingId: row.BuildingId as number, id, tenantId: (row.TenantId as number | null) ?? null });
      }
      for (const scope of scopes) {
        await executeQuery(
          connection,
          archive ? sql.archive : sql.restore,
          archive
            ? [idParam(scope.id), { name: "By", type: TYPES.NVarChar, value: actor.name }, { name: "Reason", type: TYPES.NVarChar, value: reason }]
            : [idParam(scope.id)],
        );
        await record(connection, {
          action: archive ? `${kind}.archive` : `${kind}.unarchive`,
          actor,
          buildingId: scope.buildingId,
          reason,
          subject: { id: scope.id, type: kind },
          tenantId: scope.tenantId,
        });
      }
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }
    const tenancies = new Map(scopes.filter((scope) => scope.tenantId !== null).map((scope) => [scope.tenantId, scope.buildingId]));
    for (const [tenantId, buildingId] of tenancies) invalidateTenantAndBuilding(tenantId as number, buildingId);
    return { status: 200, jsonBody: ids.length === 1 && body?.[sql.idsField] === undefined ? { archived: archive, id: ids[0], kind } : { archived: archive, ids, kind } };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error(`${archive ? "archive" : "unarchive"} ${kind} failed:`, message);
    return errorResponse(archive ? `Archive ${kind} failed` : `Restore ${kind} failed`, message);
  } finally {
    if (connection) closeConnection(connection);
  }
}
