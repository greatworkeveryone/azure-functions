import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { AppRole, errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { closeConnection, createRequestConnection, executeQuery } from "../db";
import { ARCHIVED_NOTES_SQL, noteRowToApi, setTenantNoteArchived } from "../tenant-notes";

// ── POST /api/archiveTenantNote, unarchiveTenantNote ─────────────────────────
// Body { NoteId, Reason }. Replace the hard deleteTenantNote (D11): the note
// leaves the tenancy's notes and the register's counts, stays on file, and can
// be restored. Each is ledgered with its reason. The tenancy desk's, as editing
// the tenancy is (the roles table's editTenancy).
//
// ── GET /api/getArchivedTenantNotes?tenantId= ────────────────────────────────
// The Archived view: a tenancy's archived notes, with who archived them and why.
// For the tenancy's readers, getRegisterTenant's gate.

const GATE = ACTION_ROLES.editTenancy.gate;
const TENANCY_READ = [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR];

export async function archiveTenantNote(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, GATE);
  if (denied) return denied;
  return setTenantNoteArchived(request, context, token, true);
}

export async function unarchiveTenantNote(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, GATE);
  if (denied) return denied;
  return setTenantNoteArchived(request, context, token, false);
}

export async function getArchivedTenantNotes(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, TENANCY_READ);
  if (denied) return denied;
  const raw = request.query.get("tenantId")?.trim() ?? "";
  const tenantId = /^\d{1,10}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(tenantId) || tenantId < 1) return { status: 400, jsonBody: { error: "tenantId required" } };

  let connection;
  try {
    connection = await createRequestConnection(token);
    const rows = await executeQuery(connection, ARCHIVED_NOTES_SQL, [{ name: "TenantId", type: TYPES.Int, value: tenantId }]);
    return { status: 200, jsonBody: { notes: rows.map(noteRowToApi) } };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("getArchivedTenantNotes failed:", message);
    return errorResponse("Failed to fetch archived notes", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("archiveTenantNote", { authLevel: "anonymous", handler: archiveTenantNote, methods: ["POST"] });
app.http("unarchiveTenantNote", { authLevel: "anonymous", handler: unarchiveTenantNote, methods: ["POST"] });
app.http("getArchivedTenantNotes", { authLevel: "anonymous", handler: getArchivedTenantNotes, methods: ["GET"] });
