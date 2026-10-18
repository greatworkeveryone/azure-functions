// GET /api/getProcedures
//
// The SOP library: controlled documents with immutable versions. It serves each
// reader what is written for them (procedureAudience.ts: a manager sees their
// officers' procedures, the CFO accounts', director and admin all) and drafts only
// to editors, for the procedures they can read. The frontend filters the same way,
// but presentation is not security. Editors also get the directors they can ask to
// approve a draft.
//
// Business rules (one draft + one published per slug, published implies approved)
// are enforced by migration 088's filtered unique indexes and CHECKs, not by
// handler discipline.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { closeConnection, createRequestConnection, createServiceRequestConnection, executeQuery } from "../db";
import { AppRole, errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { listActiveUsers } from "../escalation/store";
import { readCallerRoles } from "../procedureAccess";
import { approvalRequestOf, parseBlocks, splitAudience, toIsoDate, toIsoDateTime } from "../procedureLibrary";
import { ENDORSER_ROLES, canAccessProcedure } from "../procedureEndorsement";
import { PROCEDURE_EDITOR_GATE } from "../procedureRoles";

/**
 * The directors an editor can ask to approve a draft, by name. Read on the service
 * connection (the user table is not the editor's to read) and never fatal: the
 * library is more use without the picker than not at all.
 */
async function listApprovers(context: InvocationContext): Promise<Array<{ name: string; role: string; userId: number }>> {
  let connection;
  try {
    connection = await createServiceRequestConnection();
    const users = await listActiveUsers(connection);
    return users
      .filter((user) => ENDORSER_ROLES.includes(user.role))
      .map((user) => ({ name: user.name, role: user.role, userId: user.userId }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (error: any) {
    context.warn(`procedures: could not list approvers: ${error.message}`);
    return [];
  } finally {
    if (connection) closeConnection(connection);
  }
}

export async function getProcedures(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.USER]);
  if (denied) return denied;

  // A transient 503 from the role lookup counts as "cannot see drafts": hiding
  // drafts on failure is the safe direction.
  const isEditor = (await requireRole(request, PROCEDURE_EDITOR_GATE)) === null;

  // Everyone reads what is written for them, through the role hierarchy. If their
  // roles can't be read they get what is for everyone: fail closed.
  const roles = (await readCallerRoles(request)) ?? [];

  let connection;
  try {
    connection = await createRequestConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT p.Slug, p.Category, p.Audience, p.SortOrder, p.Owner, p.EndorsementAuthority, p.EndorsementVersion,
              v.VersionId, v.VersionNo, v.Title, v.Summary, v.BlocksJson, v.Status,
              v.CreatedBy, v.CreatedAt, v.ApprovedBy, v.ApprovedAt, v.PublishedAt, v.ReviewDue,
              v.ApprovalRequestedAt, v.ApprovalRequestedBy, v.ApprovalRequestedFromUserId, v.ApprovalRequestedFromName
       FROM dbo.Procedures p
       LEFT JOIN dbo.ProcedureVersions v ON v.Slug = p.Slug
       ORDER BY p.SortOrder, p.Slug, v.VersionNo DESC`,
    );

    const published = new Set(rows.filter(row => row.Status === "published").map(row => String(row.Slug)));
    const bySlug = new Map<string, { versions: unknown[]; [key: string]: unknown }>();
    for (const row of rows) {
      const slug = String(row.Slug);
      let record = bySlug.get(slug);
      if (!record) {
        const audience = splitAudience(row.Audience);
        if (!canAccessProcedure(roles, audience, String(row.EndorsementAuthority ?? "team"))) continue;
        record = {
          audience,
          endorsementAuthority: row.EndorsementAuthority ?? "team",
          endorsementVersion: Number(row.EndorsementVersion ?? 0),
          category: String(row.Category),
          order: Number(row.SortOrder),
          owner: row.Owner ?? undefined,
          slug,
          versions: [],
        };
        bySlug.set(slug, record);
      }
      if (!row.VersionId) continue;
      if (String(row.Status) === "draft" && !isEditor && published.has(slug)) continue;

      record.versions.push({
        approvedAt: toIsoDateTime(row.ApprovedAt),
        approvedBy: row.ApprovedBy ?? undefined,
        blocks: parseBlocks(row.BlocksJson, slug, (message) => context.warn(message)),
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

    const approvers = isEditor ? await listApprovers(context) : [];
    return { status: 200, jsonBody: { approvers, procedures: [...bySlug.values()] } };
  } catch (error: any) {
    context.error("getProcedures failed:", error.message);
    return errorResponse("Get procedures failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getProcedures", { methods: ["GET"], authLevel: "anonymous", handler: getProcedures });
