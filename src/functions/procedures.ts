// src/functions/procedures.ts
//
// The SOP library: controlled documents with immutable versions.
//
// Three endpoints. getProcedures serves the library (drafts, and procedures
// written for another team, only to editor-tier callers — the frontend hides
// them too, but presentation is not security; who reads what is
// procedureAudience.ts). saveProcedureDraft never touches a published row: it updates the
// single draft or creates one at the next version number, creating the parent
// dbo.Procedures row on first save of a new slug. publishProcedure promotes a
// draft, stamping the approver FROM THE TOKEN — never from the body, because
// "who approved this" is the assurance the endpoint exists to provide.
//
// Business rules (one draft + one published per slug, published ⇒ approved)
// are enforced by migration 088's filtered unique indexes and CHECKs, not by
// handler discipline.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { closeConnection, createRequestConnection, createServiceRequestConnection, executeQuery } from "../db";
import {
  AppRole,
  errorResponse,
  extractToken,
  requireRole,
  rolesForRequest,
  unauthorizedResponse,
  userInfoFromToken,
} from "../auth";
import { listActiveUsers } from "../escalation/store";
import { canReadProcedure } from "../procedureAudience";
import { PROCEDURE_APPROVER_ROLE, PROCEDURE_EDITOR_GATE } from "../procedureRoles";

// requireRole's hierarchy admits admin + director through any non-admin gate,
// so this gate resolves to: managers, director, admin. Mirrors the frontend's
// editProcedures capability.
const EDITOR_GATE = PROCEDURE_EDITOR_GATE;

const BLOCK_KINDS = ["heading", "image", "list", "paragraph", "table"];
const KNOWN_AUDIENCES = ["all", ...Object.values(AppRole)];
const REVIEW_INTERVALS = [3, 6, 12, 24];
const MAX_BLOCKS_BYTES = 512 * 1024;

/** Rejects anything the frontend renderer would not understand. */
function validateBlocks(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return "blocks must be an array";
  for (const block of blocks) {
    if (!block || typeof block !== "object") return "each block must be an object";
    const kind = (block as Record<string, unknown>).kind;
    if (typeof kind !== "string" || !BLOCK_KINDS.includes(kind)) {
      return `unknown block kind: ${String(kind)}`;
    }
    if (typeof (block as Record<string, unknown>).id !== "string") {
      return "each block needs a string id";
    }
  }
  return null;
}

function parseBlocks(json: unknown, slug: string, context: InvocationContext): unknown[] {
  try {
    const parsed: unknown = JSON.parse(String(json));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // A corrupt document renders empty rather than taking the library down.
    context.warn(`procedures: unparseable BlocksJson for ${slug}`);
    return [];
  }
}

/** The request for approval on a draft, when there is one. Only a draft carries a live request. */
function approvalRequestOf(row: Record<string, unknown>): { approvalRequest?: unknown } {
  if (String(row.Status) !== "draft" || !row.ApprovalRequestedAt) return {};
  return {
    approvalRequest: {
      at: toIsoDateTime(row.ApprovalRequestedAt),
      by: String(row.ApprovalRequestedBy ?? ""),
      from: { name: String(row.ApprovalRequestedFromName ?? ""), userId: Number(row.ApprovalRequestedFromUserId) },
    },
  };
}

/**
 * The directors an editor can ask to approve a draft, by name. Read on the service
 * connection (the user table is not the editor's to read) and never fatal: the
 * library is more use without the picker than not at all.
 */
async function listApprovers(context: InvocationContext): Promise<Array<{ name: string; userId: number }>> {
  let connection;
  try {
    connection = await createServiceRequestConnection();
    const users = await listActiveUsers(connection);
    return users
      .filter((user) => user.role === PROCEDURE_APPROVER_ROLE)
      .map((user) => ({ name: user.name, userId: user.userId }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (error: any) {
    context.warn(`procedures: could not list approvers: ${error.message}`);
    return [];
  } finally {
    if (connection) closeConnection(connection);
  }
}

const toIsoDateTime = (value: unknown): string | undefined =>
  value ? new Date(value as Date).toISOString() : undefined;
const toIsoDate = (value: unknown): string | undefined =>
  value ? new Date(value as Date).toISOString().slice(0, 10) : undefined;

export async function getProcedures(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.USER]);
  if (denied) return denied;

  // A transient 503 from the role lookup counts as "cannot see drafts" —
  // hiding drafts on failure is the safe direction.
  const canSeeDrafts = (await requireRole(request, EDITOR_GATE)) === null;

  // Everyone else reads what is written for them, through the role hierarchy.
  // If their roles can't be read they get what is for everyone: fail closed.
  let roles: string[] = [];
  if (!canSeeDrafts) {
    try {
      roles = await rolesForRequest(request);
    } catch {
      roles = [];
    }
  }

  let connection;
  try {
    connection = await createRequestConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT p.Slug, p.Category, p.Audience, p.SortOrder, p.Owner,
              v.VersionId, v.VersionNo, v.Title, v.Summary, v.BlocksJson, v.Status,
              v.CreatedBy, v.CreatedAt, v.ApprovedBy, v.ApprovedAt, v.PublishedAt, v.ReviewDue,
              v.ApprovalRequestedAt, v.ApprovalRequestedBy, v.ApprovalRequestedFromUserId, v.ApprovalRequestedFromName
       FROM dbo.Procedures p
       LEFT JOIN dbo.ProcedureVersions v ON v.Slug = p.Slug
       ORDER BY p.SortOrder, p.Slug, v.VersionNo DESC`,
    );

    const bySlug = new Map<string, { versions: unknown[]; [key: string]: unknown }>();
    for (const row of rows) {
      const slug = String(row.Slug);
      let record = bySlug.get(slug);
      if (!record) {
        const audience = String(row.Audience).split(",").map((entry) => entry.trim()).filter(Boolean);
        if (!canSeeDrafts && !canReadProcedure(roles, audience)) continue;
        record = {
          audience,
          category: String(row.Category),
          order: Number(row.SortOrder),
          owner: row.Owner ?? undefined,
          slug,
          versions: [],
        };
        bySlug.set(slug, record);
      }
      if (!row.VersionId) continue;
      if (String(row.Status) === "draft" && !canSeeDrafts) continue;

      record.versions.push({
        approvedAt: toIsoDateTime(row.ApprovedAt),
        approvedBy: row.ApprovedBy ?? undefined,
        blocks: parseBlocks(row.BlocksJson, slug, context),
        createdAt: toIsoDateTime(row.CreatedAt),
        createdBy: String(row.CreatedBy),
        publishedAt: toIsoDateTime(row.PublishedAt),
        ...approvalRequestOf(row),
        reviewDue: toIsoDate(row.ReviewDue),
        status: String(row.Status),
        summary: String(row.Summary),
        title: String(row.Title),
        version: Number(row.VersionNo),
        versionId: String(row.VersionId),
      });
    }

    const approvers = canSeeDrafts ? await listApprovers(context) : [];
    return { status: 200, jsonBody: { approvers, procedures: [...bySlug.values()] } };
  } catch (error: any) {
    context.error("getProcedures failed:", error.message);
    return errorResponse("Get procedures failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

export async function saveProcedureDraft(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const denied = await requireRole(request, EDITOR_GATE);
  if (denied) return denied;

  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const slug = String(body?.slug ?? "").trim();
    const title = String(body?.title ?? "").trim();
    const summary = String(body?.summary ?? "");

    if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(slug)) {
      return { status: 400, jsonBody: { error: "slug must be lowercase kebab-case" } };
    }
    if (!title) return { status: 400, jsonBody: { error: "title is required" } };

    const invalid = validateBlocks(body?.blocks);
    if (invalid) return { status: 400, jsonBody: { error: invalid } };

    const blocksJson = JSON.stringify(body?.blocks);
    if (Buffer.byteLength(blocksJson, "utf8") > MAX_BLOCKS_BYTES) {
      return { status: 413, jsonBody: { error: "Procedure is too large" } };
    }

    // Honoured only on first save of a NEW slug — changing an existing
    // procedure's audience is a deliberate separate action, not a side effect.
    const category =
      typeof body?.category === "string" && body.category.trim()
        ? body.category.trim().slice(0, 128)
        : "Reference";
    const audience = (Array.isArray(body?.audience) ? body.audience : [])
      .map(String)
      .filter((role) => KNOWN_AUDIENCES.includes(role));

    const author = userInfoFromToken(token);

    connection = await createRequestConnection(token);
    await executeQuery(
      connection,
      `BEGIN TRANSACTION;

       IF NOT EXISTS (SELECT 1 FROM dbo.Procedures WHERE Slug = @Slug)
         INSERT INTO dbo.Procedures (Slug, Category, Audience, SortOrder)
         SELECT @Slug, @Category, @Audience,
                ISNULL((SELECT MAX(SortOrder) FROM dbo.Procedures), 0) + 1;

       -- An edit withdraws any request for approval: what was asked about is gone.
       UPDATE dbo.ProcedureVersions
       SET Title = @Title, Summary = @Summary, BlocksJson = @Blocks,
           CreatedBy = @Author, CreatedAt = SYSUTCDATETIME(),
           ApprovalRequestedAt = NULL, ApprovalRequestedBy = NULL,
           ApprovalRequestedFromUserId = NULL, ApprovalRequestedFromName = NULL
       WHERE Slug = @Slug AND Status = 'draft';

       IF @@ROWCOUNT = 0
         INSERT INTO dbo.ProcedureVersions
           (Slug, VersionNo, Title, Summary, BlocksJson, Status, CreatedBy)
         SELECT @Slug, ISNULL(MAX(VersionNo), 0) + 1, @Title, @Summary, @Blocks, 'draft', @Author
         FROM dbo.ProcedureVersions WHERE Slug = @Slug;

       COMMIT TRANSACTION;`,
      [
        { name: "Slug", type: TYPES.NVarChar, value: slug },
        { name: "Category", type: TYPES.NVarChar, value: category },
        { name: "Audience", type: TYPES.NVarChar, value: (audience.length > 0 ? audience : ["all"]).join(",") },
        { name: "Title", type: TYPES.NVarChar, value: title },
        { name: "Summary", type: TYPES.NVarChar, value: summary },
        { name: "Blocks", type: TYPES.NVarChar, value: blocksJson },
        { name: "Author", type: TYPES.NVarChar, value: author?.name ?? author?.email ?? "Unknown" },
      ],
    );

    return { status: 200, jsonBody: { ok: true } };
  } catch (error: any) {
    context.error("saveProcedureDraft failed:", error.message);
    return errorResponse("Save procedure draft failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

export async function publishProcedure(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  // Narrower than editing: writing an SOP and putting it into force are
  // different acts. Hierarchy admits admin; director passes explicitly.
  const denied = await requireRole(request, [AppRole.DIRECTOR]);
  if (denied) return denied;

  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const slug = String(body?.slug ?? "").trim();
    const versionId = String(body?.versionId ?? "").trim();
    const months = Number(body?.reviewIntervalMonths ?? 12);

    if (!slug || !versionId) {
      return { status: 400, jsonBody: { error: "slug and versionId are required" } };
    }
    if (!REVIEW_INTERVALS.includes(months)) {
      return {
        status: 400,
        jsonBody: { error: `reviewIntervalMonths must be one of ${REVIEW_INTERVALS.join(", ")}` },
      };
    }

    const approver = userInfoFromToken(token);
    const approverName = approver?.name ?? approver?.email;
    if (!approverName) {
      return { status: 403, jsonBody: { error: "Could not identify the approver" } };
    }

    connection = await createRequestConnection(token);
    const rows = await executeQuery(
      connection,
      `BEGIN TRANSACTION;

       -- Retire the incumbent first: the one-published filtered index would
       -- otherwise reject the promotion below.
       UPDATE dbo.ProcedureVersions
       SET Status = 'archived'
       WHERE Slug = @Slug AND Status = 'published';

       UPDATE dbo.ProcedureVersions
       SET Status = 'published',
           ApprovedBy = @Approver,
           ApprovedAt = SYSUTCDATETIME(),
           PublishedAt = SYSUTCDATETIME(),
           ReviewDue = CAST(DATEADD(MONTH, @Months, SYSUTCDATETIME()) AS DATE)
       WHERE Slug = @Slug AND VersionId = @VersionId AND Status = 'draft';

       SELECT @@ROWCOUNT AS Promoted;

       COMMIT TRANSACTION;`,
      [
        { name: "Slug", type: TYPES.NVarChar, value: slug },
        { name: "VersionId", type: TYPES.UniqueIdentifier, value: versionId },
        { name: "Approver", type: TYPES.NVarChar, value: approverName },
        { name: "Months", type: TYPES.Int, value: months },
      ],
    );

    if (Number(rows[0]?.Promoted ?? 0) === 0) {
      return { status: 409, jsonBody: { error: "No matching draft to publish" } };
    }

    return { status: 200, jsonBody: { ok: true } };
  } catch (error: any) {
    context.error("publishProcedure failed:", error.message);
    return errorResponse("Publish procedure failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getProcedures", { methods: ["GET"], authLevel: "anonymous", handler: getProcedures });
app.http("saveProcedureDraft", { methods: ["POST"], authLevel: "anonymous", handler: saveProcedureDraft });
app.http("publishProcedure", { methods: ["POST"], authLevel: "anonymous", handler: publishProcedure });
