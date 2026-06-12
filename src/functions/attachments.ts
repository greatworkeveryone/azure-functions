// ─────────────────────────────────────────────────────────────────────────────
// Attachment handlers: upload + list.
//
// Upload flow: client → Azure Function (multipart) → blob storage → generate
// SAS URL → POST to myBuildings uploadAttachment → record row in SQL.
//
// List flow: returns rows from SQL with a freshly-minted read SAS URL so the
// frontend can display/preview without us exposing blobs publicly.
// ─────────────────────────────────────────────────────────────────────────────

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { closeConnection, createConnection, executeQuery } from "../db";
import { AppRole, extractToken, oidFromToken, requireRole, rolesForRequest, verifiedIdentityFromRequest, errorResponse, unauthorizedResponse, forbiddenResponse } from "../auth";
import { deleteBlob, generateReadSasUrl, uploadBlob } from "../blob-storage";
import { uploadAttachment } from "../mybuildings-client";
import { isAllowedContentType, MAX_SIZE_BYTES } from "../upload-constants";
import { checkRateLimit } from "../rateLimit";

// Server-generated email-attachment blobs land under emails/{messageId}/...
// where {messageId} is a sanitised, URL-safe slug. Any blob name claimed via
// handleClaimEmailAttachment must match this pattern — a caller cannot point
// the Attachments row at an arbitrary blob path.
const EMAIL_BLOB_PREFIX_RE = /^emails\/[A-Za-z0-9_-]+\//;

// Explicit column list — mirrors JOB_COLUMNS pattern in jobs.ts.
// BlobName is included because callers use it to mint a read SAS URL
// (see `generateReadSasUrl(r.BlobName)` in the response mapping).
// MyBuildingsConfirmedAt is included for the same SAS-vs-archived
// decision in the response mapping.
const ATTACHMENT_COLUMNS = `
  Id, WorkRequestID, JobID, JobCode,
  BlobName, OriginalName, Extension, ContentType, SizeBytes,
  UploadedBy, UploadedAt,
  MyBuildingsConfirmedAt,
  Comment
`;

// ── POST /api/uploadAttachment (multipart/form-data) ─────────────────────────
// Accepts either `jobId` (preferred — new attachments belong to a Job) or
// `workRequestId` (legacy intake path: the WR has not been promoted to a
// Job yet, so we land with JobID NULL and let upsertJob claim the row when
// the Job is created). At least one is required.

async function handleUploadAttachment(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.USER, AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.DIRECTOR]);
  if (denied) return denied;

  // UploadedBy is an audit column — derive from the verified token, never the body.
  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const callerOid = identity.oid;

  const rl = checkRateLimit(`uploadAttachment:${callerOid}`, { limit: 30, windowMs: 60_000 });
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  let connection;
  try {
    const form = await request.formData();
    const file = form.get("file") as unknown as File | null;
    const jobIdRaw = form.get("jobId");
    const workRequestIdRaw = form.get("workRequestId");
    const jobCode = form.get("jobCode")?.toString() ?? null;

    if (!file || typeof (file as any).arrayBuffer !== "function") {
      return { status: 400, jsonBody: { error: "Missing 'file' field in multipart body" } };
    }
    if (!jobIdRaw && !workRequestIdRaw) {
      return { status: 400, jsonBody: { error: "Missing 'jobId' or 'workRequestId' field" } };
    }

    const jobId = jobIdRaw ? parseInt(jobIdRaw.toString(), 10) : null;
    const workRequestId = workRequestIdRaw ? parseInt(workRequestIdRaw.toString(), 10) : null;
    if (jobId !== null && !Number.isFinite(jobId)) {
      return { status: 400, jsonBody: { error: "'jobId' must be a number" } };
    }
    if (workRequestId !== null && !Number.isFinite(workRequestId)) {
      return { status: 400, jsonBody: { error: "'workRequestId' must be a number" } };
    }

    const contentType = (file as any).type || "application/octet-stream";
    if (!isAllowedContentType(contentType)) {
      return { status: 415, jsonBody: { error: `File type '${contentType}' is not allowed` } };
    }

    const size = (file as any).size as number;
    if (size > MAX_SIZE_BYTES) {
      return { status: 413, jsonBody: { error: `File exceeds ${MAX_SIZE_BYTES / 1024 / 1024} MB limit` } };
    }

    const originalName = (file as any).name as string;
    const buffer = Buffer.from(await (file as any).arrayBuffer());

    // Blob path uses the strongest scope we have: prefer job-scoped, fall back
    // to wr-scoped for legacy intake. Path is purely organisational — the row
    // is what actually anchors the file to a Job/WR. Prefix shape is
    // `attachments/{parentType}/{parentId}/...` so downstream code can reject
    // attempts to reference blobs outside the expected parent scope.
    const keyPrefix = jobId !== null
      ? `attachments/jobs/${jobId}`
      : `attachments/workRequests/${workRequestId}`;
    const scopeLabel =
      jobId !== null ? `Job ${jobId}` : `WR ${workRequestId}`;
    context.log(`Uploading ${originalName} (${contentType}, ${size} bytes) for ${scopeLabel}`);
    const { blobName } = await uploadBlob(buffer, originalName, contentType, keyPrefix);
    const sasUrl = generateReadSasUrl(blobName);

    // Push to myBuildings only when there's a WR to push it to. Job-scoped
    // uploads with no WR stay local.
    const extension = originalName.includes(".") ? originalName.split(".").pop() ?? "" : "";
    if (workRequestId !== null) {
      await uploadAttachment({
        Attachment_Extension: extension,
        Attachment_Name: originalName,
        Attachment_URL: sasUrl,
        JobCode: jobCode ?? undefined,
        WorkRequestID: workRequestId,
      });
    }

    // Record locally
    connection = await createConnection(token);
    const inserted = await executeQuery(
      connection,
      `INSERT INTO Attachments (JobID, WorkRequestID, JobCode, BlobName, OriginalName, Extension, ContentType, SizeBytes, UploadedBy)
       OUTPUT INSERTED.*
       VALUES (@JobID, @WorkRequestID, @JobCode, @BlobName, @OriginalName, @Extension, @ContentType, @SizeBytes, @UploadedBy)`,
      [
        { name: "JobID", type: TYPES.Int, value: jobId },
        { name: "WorkRequestID", type: TYPES.Int, value: workRequestId },
        { name: "JobCode", type: TYPES.NVarChar, value: jobCode },
        { name: "BlobName", type: TYPES.NVarChar, value: blobName },
        { name: "OriginalName", type: TYPES.NVarChar, value: originalName },
        { name: "Extension", type: TYPES.NVarChar, value: extension },
        { name: "ContentType", type: TYPES.NVarChar, value: contentType },
        { name: "SizeBytes", type: TYPES.BigInt, value: size },
        { name: "UploadedBy", type: TYPES.NVarChar, value: callerOid },
      ],
    );

    const row = inserted[0];
    return {
      status: 200,
      jsonBody: {
        attachment: { ...row, sasUrl },
      },
    };
  } catch (error: any) {
    context.error("uploadAttachment failed:", error.message);
    return errorResponse("Upload failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── GET /api/getAttachments?jobId=X | ?workRequestId=X ───────────────────────
// Pass `jobId` (preferred) for the job-scoped list, or `workRequestId` for
// the legacy WR-scoped view (used by the WR detail surfaces during cutover).

async function handleGetAttachments(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.USER, AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.DIRECTOR]);
  if (denied) return denied;

  const callerOid = oidFromToken(token) ?? "unknown";
  const rl = checkRateLimit(`getAttachments:${callerOid}`, { limit: 30, windowMs: 60_000 });
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  const jobIdRaw = request.query.get("jobId");
  const workRequestIdRaw = request.query.get("workRequestId");
  if (!jobIdRaw && !workRequestIdRaw) {
    return { status: 400, jsonBody: { error: "jobId or workRequestId is required" } };
  }
  const jobId = jobIdRaw ? parseInt(jobIdRaw, 10) : null;
  const workRequestId = workRequestIdRaw ? parseInt(workRequestIdRaw, 10) : null;
  if (jobId !== null && !Number.isFinite(jobId)) {
    return { status: 400, jsonBody: { error: "jobId must be a number" } };
  }
  if (workRequestId !== null && !Number.isFinite(workRequestId)) {
    return { status: 400, jsonBody: { error: "workRequestId must be a number" } };
  }

  let connection;
  try {
    connection = await createConnection(token);
    const rows = jobId !== null
      ? await executeQuery(
          connection,
          `SELECT ${ATTACHMENT_COLUMNS} FROM Attachments WHERE JobID=@JobID ORDER BY UploadedAt DESC`,
          [{ name: "JobID", type: TYPES.Int, value: jobId }],
        )
      : await executeQuery(
          connection,
          `SELECT ${ATTACHMENT_COLUMNS} FROM Attachments WHERE WorkRequestID=@WorkRequestID ORDER BY UploadedAt DESC`,
          [{ name: "WorkRequestID", type: TYPES.Int, value: workRequestId }],
        );

    // Mint a fresh read SAS for rows whose blob still exists. Once a blob has
    // been cleaned up (MyBuildingsConfirmedAt set), the SAS would 404 — return
    // null so the UI can show the row as archived.
    const attachments = rows.map((r: any) => ({
      ...r,
      sasUrl: r.MyBuildingsConfirmedAt ? null : generateReadSasUrl(r.BlobName),
    }));

    return { status: 200, jsonBody: { attachments, count: attachments.length } };
  } catch (error: any) {
    context.error("getAttachments failed:", error.message);
    return errorResponse("Fetch failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── Join-table helpers (PurchaseOrderAttachments / QuoteAttachments) ────────
// One pair of endpoints per parent. Idempotent attach (NOT EXISTS guard) so
// the FE can call without first checking; detach is a plain DELETE.

interface JoinSpec {
  table: string;
  parentColumn: string;
  parentParam: string;
}

const PO_JOIN: JoinSpec = {
  parentColumn: "PurchaseOrderID",
  parentParam: "PurchaseOrderID",
  table: "PurchaseOrderAttachments",
};
const QUOTE_JOIN: JoinSpec = {
  parentColumn: "QuoteID",
  parentParam: "QuoteID",
  table: "QuoteAttachments",
};

async function attachToParent(
  request: HttpRequest,
  context: InvocationContext,
  spec: JoinSpec,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.USER, AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.DIRECTOR]);
  if (denied) return denied;

  let connection;
  try {
    const body = (await request.json()) as any;
    const parentId = body?.[spec.parentParam];
    const attachmentId = body?.AttachmentID;
    const attachedBy = body?.AttachedBy ?? null;
    if (typeof parentId !== "number" || typeof attachmentId !== "number") {
      return {
        status: 400,
        jsonBody: { error: `${spec.parentParam} (number) and AttachmentID (number) required` },
      };
    }

    connection = await createConnection(token);
    /* eslint-disable local/no-sql-interpolation -- spec is always PO_JOIN or QUOTE_JOIN (compile-time JoinSpec consts bound at app.http registration), not user input. */
    await executeQuery(
      connection,
      `IF NOT EXISTS (
         SELECT 1 FROM ${spec.table}
          WHERE ${spec.parentColumn} = @ParentID AND AttachmentID = @AttachmentID
       )
       INSERT INTO ${spec.table} (${spec.parentColumn}, AttachmentID, AttachedBy)
       VALUES (@ParentID, @AttachmentID, @AttachedBy)`,
      [
        { name: "ParentID", type: TYPES.Int, value: parentId },
        { name: "AttachmentID", type: TYPES.Int, value: attachmentId },
        { name: "AttachedBy", type: TYPES.NVarChar, value: attachedBy },
      ],
    );
    /* eslint-enable local/no-sql-interpolation */
    return { status: 200, jsonBody: { ok: true } };
  } catch (error: any) {
    context.error(`attach (${spec.table}) failed:`, error.message);
    return errorResponse("Attach failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

async function detachFromParent(
  request: HttpRequest,
  context: InvocationContext,
  spec: JoinSpec,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.USER, AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.DIRECTOR]);
  if (denied) return denied;

  let connection;
  try {
    const body = (await request.json()) as any;
    const parentId = body?.[spec.parentParam];
    const attachmentId = body?.AttachmentID;
    if (typeof parentId !== "number" || typeof attachmentId !== "number") {
      return {
        status: 400,
        jsonBody: { error: `${spec.parentParam} (number) and AttachmentID (number) required` },
      };
    }

    connection = await createConnection(token);
    /* eslint-disable local/no-sql-interpolation -- spec is always PO_JOIN or QUOTE_JOIN (compile-time JoinSpec consts bound at app.http registration), not user input. */
    await executeQuery(
      connection,
      `DELETE FROM ${spec.table}
        WHERE ${spec.parentColumn} = @ParentID AND AttachmentID = @AttachmentID`,
      [
        { name: "ParentID", type: TYPES.Int, value: parentId },
        { name: "AttachmentID", type: TYPES.Int, value: attachmentId },
      ],
    );
    /* eslint-enable local/no-sql-interpolation */
    return { status: 200, jsonBody: { ok: true } };
  } catch (error: any) {
    context.error(`detach (${spec.table}) failed:`, error.message);
    return errorResponse("Detach failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

async function listParentAttachments(
  request: HttpRequest,
  context: InvocationContext,
  spec: JoinSpec,
  queryParam: string,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.USER, AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.DIRECTOR]);
  if (denied) return denied;

  const callerOid = oidFromToken(token) ?? "unknown";
  const rl = checkRateLimit(`listParentAttachments:${callerOid}`, { limit: 30, windowMs: 60_000 });
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  const raw = request.query.get(queryParam);
  if (!raw) {
    return { status: 400, jsonBody: { error: `${queryParam} is required` } };
  }
  const parentId = parseInt(raw, 10);
  if (!Number.isFinite(parentId)) {
    return { status: 400, jsonBody: { error: `${queryParam} must be a number` } };
  }

  let connection;
  try {
    connection = await createConnection(token);
    /* eslint-disable local/no-sql-interpolation -- spec is always PO_JOIN or QUOTE_JOIN (compile-time JoinSpec consts bound at app.http registration), not user input. */
    const rows = await executeQuery(
      connection,
      `SELECT a.*
         FROM ${spec.table} j
         JOIN Attachments a ON a.Id = j.AttachmentID
        WHERE j.${spec.parentColumn} = @ParentID
        ORDER BY j.AttachedAt DESC`,
      [{ name: "ParentID", type: TYPES.Int, value: parentId }],
    );
    /* eslint-enable local/no-sql-interpolation */
    const attachments = rows.map((r: any) => ({
      ...r,
      sasUrl: r.MyBuildingsConfirmedAt ? null : generateReadSasUrl(r.BlobName),
    }));
    return { status: 200, jsonBody: { attachments, count: attachments.length } };
  } catch (error: any) {
    context.error(`list (${spec.table}) failed:`, error.message);
    return errorResponse("Fetch failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/deleteAttachment ──────────────────────────────────────────────
// Body: { AttachmentID }. Deletes the local blob + the Attachments row;
// PurchaseOrderAttachments / QuoteAttachments rows are removed via the
// cascading FKs (see migration 010). Archived rows (MyBuildingsConfirmedAt
// set) keep no local blob, so the storage delete is skipped.

async function handleDeleteAttachment(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.USER, AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.DIRECTOR]);
  if (denied) return denied;

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const callerOid = identity.oid;

  const rl = checkRateLimit(`deleteAttachment:${callerOid}`, { limit: 60, windowMs: 60_000 });
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  let connection;
  try {
    const body = (await request.json()) as any;
    const attachmentId = body?.AttachmentID;
    if (typeof attachmentId !== "number") {
      return { status: 400, jsonBody: { error: "AttachmentID (number) required" } };
    }

    connection = await createConnection(token);
    // Pull UploadedBy alongside the blob name + parent IDs so we can enforce
    // per-row ownership (IDOR). The JOIN against parent tables is informational —
    // the comparison rule is admin OR UploadedBy === callerOid. The parent owner
    // OID is not currently a reliable column on every parent table (display name
    // strings dominate), so we don't gate on it.
    const rows = await executeQuery(
      connection,
      `SELECT a.BlobName, a.MyBuildingsConfirmedAt, a.UploadedBy,
              a.JobID, a.WorkRequestID,
              j.CreatedBy AS JobCreatedBy
         FROM Attachments a
         LEFT JOIN Jobs j ON j.JobID = a.JobID
        WHERE a.Id = @Id`,
      [{ name: "Id", type: TYPES.Int, value: attachmentId }],
    );
    if (rows.length === 0) {
      return { status: 404, jsonBody: { error: "Attachment not found" } };
    }
    const blobName = rows[0].BlobName as string;
    const archived = rows[0].MyBuildingsConfirmedAt != null;
    const uploadedBy = rows[0].UploadedBy as string | null;

    const callerRoles = await rolesForRequest(request);
    const isAdmin = callerRoles.includes(AppRole.ADMIN);
    const isOwner = uploadedBy != null && uploadedBy === callerOid;
    if (!isAdmin && !isOwner) {
      return forbiddenResponse("Only the uploader or an admin can delete this attachment.");
    }

    if (!archived) {
      try {
        await deleteBlob(blobName);
      } catch (err: any) {
        // Don't fail the row delete if the blob is already gone — log and move on.
        context.warn(`deleteAttachment: blob delete failed for ${blobName}: ${err?.message}`);
      }
    }

    await executeQuery(
      connection,
      "DELETE FROM Attachments WHERE Id = @Id",
      [{ name: "Id", type: TYPES.Int, value: attachmentId }],
    );
    return { status: 200, jsonBody: { deleted: attachmentId } };
  } catch (error: any) {
    context.error("deleteAttachment failed:", error.message);
    return errorResponse("Delete failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/claimEmailAttachment ───────────────────────────────────────────
// Body: { BlobName, FileName, JobID, ClaimedBy? }
// The blob is already in Azure Storage (it arrived with the email). This
// endpoint simply registers it in the Attachments table so it appears in the
// job's attachment list without uploading anything.

async function handleClaimEmailAttachment(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.USER, AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.DIRECTOR]);
  if (denied) return denied;

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const callerOid = identity.oid;

  const rl = checkRateLimit(`claimEmailAttachment:${callerOid}`, { limit: 30, windowMs: 60_000 });
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  let connection;
  try {
    const body = (await request.json()) as any;
    const { BlobName, FileName, JobID } = body ?? {};
    if (!BlobName || typeof BlobName !== "string") {
      return { status: 400, jsonBody: { error: "BlobName (string) required" } };
    }
    // Only blobs landed by the email-sync pipeline (under emails/{messageId}/)
    // can be claimed — caller cannot point the row at an arbitrary blob path.
    if (!EMAIL_BLOB_PREFIX_RE.test(BlobName)) {
      return { status: 400, jsonBody: { error: "Invalid attachment reference" } };
    }
    if (!JobID || typeof JobID !== "number") {
      return { status: 400, jsonBody: { error: "JobID (number) required" } };
    }

    // TODO: cross-check the email referenced by the blob path belongs to a job
    // the caller can write to (per-job ownership). For now the role gate above
    // plus the server-generated blob-prefix check are the enforced controls.

    const extension = typeof FileName === "string" && FileName.includes(".")
      ? FileName.split(".").pop() ?? null
      : null;
    const sasUrl = generateReadSasUrl(BlobName);

    connection = await createConnection(token);
    const inserted = await executeQuery(
      connection,
      `INSERT INTO Attachments (JobID, BlobName, OriginalName, Extension, UploadedBy)
       OUTPUT INSERTED.*
       VALUES (@JobID, @BlobName, @OriginalName, @Extension, @UploadedBy)`,
      [
        { name: "JobID", type: TYPES.Int, value: JobID },
        { name: "BlobName", type: TYPES.NVarChar, value: BlobName },
        { name: "OriginalName", type: TYPES.NVarChar, value: FileName ?? BlobName },
        { name: "Extension", type: TYPES.NVarChar, value: extension },
        { name: "UploadedBy", type: TYPES.NVarChar, value: callerOid },
      ],
    );

    return { status: 200, jsonBody: { attachment: { ...inserted[0], sasUrl } } };
  } catch (error: any) {
    context.error("claimEmailAttachment failed:", error.message);
    return errorResponse("Claim failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/updateAttachmentComment ────────────────────────────────────────
// Body: { AttachmentID, Comment }. Saves (or clears) the free-text comment on
// an attachment row. Returns the updated attachment with a fresh SAS URL.

async function handleUpdateAttachmentComment(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.USER, AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.DIRECTOR]);
  if (denied) return denied;

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const callerOid = identity.oid;

  const rl = checkRateLimit(`updateAttachmentComment:${callerOid}`, { limit: 60, windowMs: 60_000 });
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  let connection;
  try {
    const body = (await request.json()) as any;
    const { AttachmentID, Comment } = body ?? {};
    if (typeof AttachmentID !== "number") {
      return { status: 400, jsonBody: { error: "AttachmentID (number) required" } };
    }

    connection = await createConnection(token);
    // Per-row ownership: only the uploader or an admin can edit the comment.
    // Parent-table JOIN is informational; gating uses UploadedBy.
    const ownership = await executeQuery(
      connection,
      `SELECT a.UploadedBy, a.JobID, j.CreatedBy AS JobCreatedBy
         FROM Attachments a
         LEFT JOIN Jobs j ON j.JobID = a.JobID
        WHERE a.Id = @Id`,
      [{ name: "Id", type: TYPES.Int, value: AttachmentID }],
    );
    if (ownership.length === 0) {
      return { status: 404, jsonBody: { error: "Attachment not found" } };
    }
    const uploadedBy = ownership[0].UploadedBy as string | null;
    const callerRoles = await rolesForRequest(request);
    const isAdmin = callerRoles.includes(AppRole.ADMIN);
    const isOwner = uploadedBy != null && uploadedBy === callerOid;
    if (!isAdmin && !isOwner) {
      return forbiddenResponse("Only the uploader or an admin can edit this attachment's comment.");
    }

    await executeQuery(
      connection,
      "UPDATE Attachments SET Comment = @Comment WHERE Id = @Id",
      [
        { name: "Id", type: TYPES.Int, value: AttachmentID },
        { name: "Comment", type: TYPES.NVarChar, value: typeof Comment === "string" ? Comment : null },
      ],
    );

    const rows = await executeQuery(
      connection,
      `SELECT ${ATTACHMENT_COLUMNS} FROM Attachments WHERE Id = @Id`,
      [{ name: "Id", type: TYPES.Int, value: AttachmentID }],
    );
    if (rows.length === 0) {
      return { status: 404, jsonBody: { error: "Attachment not found" } };
    }
    const r = rows[0] as any;
    return {
      status: 200,
      jsonBody: {
        attachment: {
          ...r,
          sasUrl: r.MyBuildingsConfirmedAt ? null : generateReadSasUrl(r.BlobName),
        },
      },
    };
  } catch (error: any) {
    context.error("updateAttachmentComment failed:", error.message);
    return errorResponse("Failed to update comment", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("claimEmailAttachment", { methods: ["POST"], authLevel: "anonymous", handler: handleClaimEmailAttachment });
app.http("uploadAttachment", { methods: ["POST"], authLevel: "anonymous", handler: handleUploadAttachment });
app.http("getAttachments", { methods: ["GET"], authLevel: "anonymous", handler: handleGetAttachments });
app.http("deleteAttachment", { methods: ["POST"], authLevel: "anonymous", handler: handleDeleteAttachment });
app.http("updateAttachmentComment", { methods: ["POST"], authLevel: "anonymous", handler: handleUpdateAttachmentComment });

app.http("attachToPurchaseOrder", {
  authLevel: "anonymous",
  handler: (req, ctx) => attachToParent(req, ctx, PO_JOIN),
  methods: ["POST"],
});
app.http("detachFromPurchaseOrder", {
  authLevel: "anonymous",
  handler: (req, ctx) => detachFromParent(req, ctx, PO_JOIN),
  methods: ["POST"],
});
app.http("getPurchaseOrderAttachments", {
  authLevel: "anonymous",
  handler: (req, ctx) => listParentAttachments(req, ctx, PO_JOIN, "purchaseOrderId"),
  methods: ["GET"],
});

app.http("attachToQuote", {
  authLevel: "anonymous",
  handler: (req, ctx) => attachToParent(req, ctx, QUOTE_JOIN),
  methods: ["POST"],
});
app.http("detachFromQuote", {
  authLevel: "anonymous",
  handler: (req, ctx) => detachFromParent(req, ctx, QUOTE_JOIN),
  methods: ["POST"],
});
app.http("getQuoteAttachments", {
  authLevel: "anonymous",
  handler: (req, ctx) => listParentAttachments(req, ctx, QUOTE_JOIN, "quoteId"),
  methods: ["GET"],
});
