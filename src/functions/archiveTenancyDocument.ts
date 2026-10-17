import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { AppRole, errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { beginTransaction, closeConnection, commitTransaction, createRequestConnection, executeQuery, rollbackTransaction } from "../db";
import { record } from "../ledger";
import { resolveLedgerActor } from "../ledger/actor";

// ── POST /api/archiveTenancyDocument ─────────────────────────────────────────
// Body: { TenantId, AttachmentID }. A lease document is archived, never
// deleted (D4, DL-19): the file and its link stay; Attachments.ArchivedAt/By
// (migration 135) take it out of the documents list unless asked for, and
// tenancy.document_archive is ledgered against the tenancy. Same roles as
// uploading a tenancy document.

export async function archiveTenancyDocument(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR]);
  if (denied) return denied;

  const body = (await request.json().catch(() => null)) as { AttachmentID?: unknown; TenantId?: unknown } | null;
  const tenantId = body?.TenantId;
  const attachmentId = body?.AttachmentID;
  if (typeof tenantId !== "number" || typeof attachmentId !== "number") {
    return { status: 400, jsonBody: { error: "TenantId (number) and AttachmentID (number) required" } };
  }

  let connection;
  try {
    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();

    await beginTransaction(connection);
    try {
      const [doc] = await executeQuery(
        connection,
        `SELECT a.OriginalName, a.ArchivedAt, t.BuildingId
           FROM dbo.TenancyAttachments ta WITH (UPDLOCK, HOLDLOCK)
           JOIN dbo.Attachments a WITH (UPDLOCK, HOLDLOCK) ON a.Id = ta.AttachmentID
           JOIN dbo.Tenants t ON t.TenantId = ta.TenantId
          WHERE ta.TenantId = @TenantId AND ta.AttachmentID = @AttachmentID`,
        [
          { name: "TenantId", type: TYPES.Int, value: tenantId },
          { name: "AttachmentID", type: TYPES.Int, value: attachmentId },
        ],
      );
      if (!doc) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: "That document isn't on this tenancy" } };
      }
      if (doc.ArchivedAt != null) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 409, jsonBody: { error: "That document is already archived" } };
      }
      await executeQuery(
        connection,
        `UPDATE dbo.Attachments SET ArchivedAt = SYSUTCDATETIME(), ArchivedBy = @By
          WHERE Id = @AttachmentID AND ArchivedAt IS NULL`,
        [
          { name: "AttachmentID", type: TYPES.Int, value: attachmentId },
          { name: "By", type: TYPES.NVarChar, value: actor.name },
        ],
      );
      await record(connection, {
        action: "tenancy.document_archive",
        actor,
        before: { attachmentId, fileName: (doc.OriginalName as string | null) ?? null },
        buildingId: (doc.BuildingId as number | null) ?? null,
        subject: { id: tenantId, type: "tenancy" },
        tenantId,
      });
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }
    return { status: 200, jsonBody: { archived: true, attachmentId } };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("archiveTenancyDocument failed:", message);
    return errorResponse("Archive document failed", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("archiveTenancyDocument", { authLevel: "anonymous", handler: archiveTenancyDocument, methods: ["POST"] });
