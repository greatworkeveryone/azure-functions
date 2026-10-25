import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { errorResponse, unauthorizedResponse } from "./auth";
import { beginTransaction, closeConnection, commitTransaction, createRequestConnection, executeQuery, rollbackTransaction, type SqlRow } from "./db";
import { record } from "./ledger";
import { resolveLedgerActor } from "./ledger/actor";
import { invalidateTenantAndBuilding } from "./tenant-register-cache";

// A tenancy's notes (dbo.TenantNotes): what staff write about a tenancy, and
// the change notes written when a lease field is edited. They are archived,
// never hard-deleted (D11; database-safety rule 1; migration 141). Archive
// stamps who, when and why; restore clears it; each is ledgered with its
// reason in the same transaction. Who may: the roles table's editTenancy gate.

export const NOTE_COLUMNS = `NoteId, TenantId, AnchorKind, OccupancyId, FieldKey, Body,
              CreatedAt, CreatedById, CreatedByName, ArchivedAt, ArchivedBy, ArchiveReason`;

export interface TenantNoteApi {
  anchorKind: "field" | "occupancy" | "tenant";
  /** Set when the note is archived (D11); only the Archived view returns those. */
  archivedAt: string | null;
  archivedBy: string | null;
  archiveReason: string | null;
  body: string;
  createdAt: string;
  createdBy: { id: string; name: string };
  fieldKey?: string;
  noteId: string;
  occupancyId?: string;
  tenantId: number;
}

const iso = (value: unknown): string => (value ? new Date(value as Date | string).toISOString() : "");
const text = (value: unknown): string | undefined => (value === null || value === undefined ? undefined : String(value));

export function noteRowToApi(row: SqlRow): TenantNoteApi {
  return {
    anchorKind: row.AnchorKind as TenantNoteApi["anchorKind"],
    archivedAt: row.ArchivedAt ? iso(row.ArchivedAt) : null,
    archivedBy: text(row.ArchivedBy) ?? null,
    archiveReason: text(row.ArchiveReason) ?? null,
    body: row.Body as string,
    createdAt: iso(row.CreatedAt),
    createdBy: { id: (row.CreatedById as string) ?? "", name: (row.CreatedByName as string) ?? "" },
    fieldKey: text(row.FieldKey),
    noteId: row.NoteId as string,
    occupancyId: text(row.OccupancyId),
    tenantId: row.TenantId as number,
  };
}

const LOCKED_NOTE = `SELECT n.TenantId, t.BuildingId, n.ArchivedAt
  FROM dbo.TenantNotes n WITH (UPDLOCK, HOLDLOCK)
  JOIN dbo.Tenants t ON t.TenantId = n.TenantId
 WHERE n.NoteId = @Id`;
const ARCHIVE = `UPDATE dbo.TenantNotes SET ArchivedAt = SYSUTCDATETIME(), ArchivedBy = @By, ArchiveReason = @Reason
 WHERE NoteId = @Id AND ArchivedAt IS NULL`;
const RESTORE = `UPDATE dbo.TenantNotes SET ArchivedAt = NULL, ArchivedBy = NULL, ArchiveReason = NULL
 WHERE NoteId = @Id AND ArchivedAt IS NOT NULL`;

export const MAX_NOTE_REASON = 2000;

/** Archive (or restore) one note, after the route's role check. Body { NoteId, Reason }. */
export async function setTenantNoteArchived(
  request: HttpRequest,
  context: InvocationContext,
  token: string,
  archive: boolean,
): Promise<HttpResponseInit> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const noteId = body?.NoteId;
  const reason = typeof body?.Reason === "string" ? body.Reason.trim() : "";
  if (typeof noteId !== "string" || !noteId) return { status: 400, jsonBody: { error: "NoteId required" } };
  if (!reason) return { status: 400, jsonBody: { error: "A reason is required" } };
  if (reason.length > MAX_NOTE_REASON) return { status: 400, jsonBody: { error: `Reason must be ${MAX_NOTE_REASON} characters or fewer` } };

  let connection;
  try {
    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();
    const idParam = { name: "Id", type: TYPES.NVarChar, value: noteId };

    let scope: { buildingId: number; tenantId: number };
    await beginTransaction(connection);
    try {
      const [row] = await executeQuery(connection, LOCKED_NOTE, [idParam]);
      if (!row) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: "Note not found" } };
      }
      const archived = row.ArchivedAt !== null && row.ArchivedAt !== undefined;
      if (archived === archive) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 409, jsonBody: { error: archive ? "This note is already archived." : "This note is not archived." } };
      }
      scope = { buildingId: row.BuildingId as number, tenantId: row.TenantId as number };
      await executeQuery(
        connection,
        archive ? ARCHIVE : RESTORE,
        archive ? [idParam, { name: "By", type: TYPES.NVarChar, value: actor.name }, { name: "Reason", type: TYPES.NVarChar, value: reason }] : [idParam],
      );
      await record(connection, {
        action: archive ? "tenancy_note.archive" : "tenancy_note.unarchive",
        actor,
        buildingId: scope.buildingId,
        reason,
        subject: { id: noteId, type: "tenancy_note" },
        tenantId: scope.tenantId,
      });
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }
    invalidateTenantAndBuilding(scope.tenantId, scope.buildingId);
    return { status: 200, jsonBody: { archived: archive, noteId } };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error(`${archive ? "archive" : "unarchive"} tenant note failed:`, message);
    return errorResponse(archive ? "Archive note failed" : "Restore note failed", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// The Archived view: one tenancy's archived notes, newest archived first.
export const ARCHIVED_NOTES_SQL = `SELECT ${NOTE_COLUMNS}
  FROM dbo.TenantNotes
 WHERE TenantId = @TenantId AND ArchivedAt IS NOT NULL
 ORDER BY ArchivedAt DESC`;
