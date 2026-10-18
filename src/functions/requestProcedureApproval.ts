// POST /api/requestProcedureApproval   { slug, versionId, approverUserId }
//
// A manager asks a director to approve a procedure draft (beta sprint U4, the
// minimal version of the approval step). The request is recorded on the draft
// itself (migration 142) so the library can say "Awaiting approval by Dee", and
// the director is emailed a link to the editor, where Publish is. Publishing is
// still the director's own act: this endpoint approves nothing.
//
//   200 { ok, notified, approver: { userId, name }, requestedAt }
//   409 when the version is not a draft any more, or has nothing in it
//
// Asking again replaces the request (another director, or a reminder), but not
// the same director twice inside ten minutes (429): one email each time is a way
// to nag. Editing the draft withdraws the request (saveProcedureDraft). An editor
// asks about the procedures written for their own team (403 otherwise). The email
// is best effort: a failure keeps the request and says notified: false.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { errorResponse, extractToken, requireRole, serviceUnavailableResponse, unauthorizedResponse, userInfoFromToken } from "../auth";
import { closeConnection, createRequestConnection, createServiceRequestConnection, executeQuery } from "../db";
import { resolveRecipient } from "../email-recipient";
import { listActiveUsers } from "../escalation/store";
import { graphSendMail } from "../graph";
import { outsideAudienceResponse, readCallerRoles } from "../procedureAccess";
import { canReadProcedure } from "../procedureAudience";
import { splitAudience } from "../procedureLibrary";
import { PROCEDURE_APPROVER_ROLE, PROCEDURE_EDITOR_GATE } from "../procedureRoles";
import { NOT_A_RECORD } from "../test-data";

/** The same director is not asked again within this long. */
const ASK_AGAIN_AFTER_MS = 10 * 60_000;

interface Approver {
  email: string | null;
  name: string;
  userId: number;
}

/** The active director with this id, or null: only a director can approve, so only a director can be asked. */
async function findApprover(userId: number): Promise<Approver | null> {
  let connection;
  try {
    connection = await createServiceRequestConnection();
    const users = await listActiveUsers(connection);
    const found = users.find((user) => user.userId === userId && user.role === PROCEDURE_APPROVER_ROLE);
    return found ? { email: found.email, name: found.name, userId: found.userId } : null;
  } finally {
    if (connection) closeConnection(connection);
  }
}

/** A 429 naming how long to wait when this director was asked about this draft a moment ago; null otherwise. */
function waitBeforeAskingAgain(draft: Record<string, unknown>, approver: Approver): HttpResponseInit | null {
  if (!draft.ApprovalRequestedAt || Number(draft.ApprovalRequestedFromUserId) !== approver.userId) return null;
  const waitMs = ASK_AGAIN_AFTER_MS - (Date.now() - new Date(draft.ApprovalRequestedAt as Date).getTime());
  if (waitMs <= 0) return null;
  const minutes = Math.ceil(waitMs / 60_000);
  return {
    headers: { "Retry-After": String(Math.ceil(waitMs / 1000)) },
    jsonBody: { error: `You asked ${approver.name} a moment ago. Give them time, or try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.` },
    status: 429,
  };
}

function hasContent(blocksJson: unknown): boolean {
  try {
    const blocks: unknown = JSON.parse(String(blocksJson));
    return Array.isArray(blocks) && blocks.length > 0;
  } catch {
    return false;
  }
}

/** Tells the director, best effort. The subject names no procedure: it shows on lock screens. */
async function notify(approver: Approver, requestedBy: string, title: string, slug: string, context: InvocationContext): Promise<boolean> {
  const { address } = resolveRecipient(approver.email);
  if (!address) return false;
  const base = (process.env.APP_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const lines = [
    `${requestedBy} has asked you to approve the procedure "${title}".`,
    "",
    base ? `Read it and publish it here: ${base}/procedures/${slug}/edit` : "Open Procedures in Floorplan, then the procedure, to read it and publish it.",
  ];
  try {
    await graphSendMail(NOT_A_RECORD, address, "A procedure is waiting for your approval", lines.join("\n"));
    return true;
  } catch (error: any) {
    context.warn(`requestProcedureApproval: could not email approver ${approver.userId}: ${error.message}`);
    return false;
  }
}

export async function requestProcedureApproval(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, PROCEDURE_EDITOR_GATE);
  if (denied) return denied;

  let connection;
  try {
    const body = (await request.json()) as Record<string, unknown> | null;
    const slug = typeof body?.slug === "string" ? body.slug.trim() : "";
    const versionId = typeof body?.versionId === "string" ? body.versionId.trim() : "";
    const approverUserId = body?.approverUserId;
    if (!slug || !versionId) return { status: 400, jsonBody: { error: "slug and versionId are required" } };
    if (typeof approverUserId !== "number" || !Number.isInteger(approverUserId) || approverUserId < 1) {
      return { status: 400, jsonBody: { error: "approverUserId must be a whole number" } };
    }

    const approver = await findApprover(approverUserId);
    if (!approver) return { status: 400, jsonBody: { error: "Pick a director: only a director can approve a procedure." } };

    const requester = userInfoFromToken(token);
    const requestedBy = requester?.name ?? requester?.email ?? "Someone";

    connection = await createRequestConnection(token);
    const drafts = await executeQuery(
      connection,
      `SELECT v.Title, v.VersionNo, v.BlocksJson, v.ApprovalRequestedAt, v.ApprovalRequestedFromUserId, p.Audience
       FROM dbo.ProcedureVersions v
       INNER JOIN dbo.Procedures p ON p.Slug = v.Slug
       WHERE v.Slug = @Slug AND v.VersionId = @VersionId AND v.Status = 'draft'`,
      [
        { name: "Slug", type: TYPES.NVarChar, value: slug },
        { name: "VersionId", type: TYPES.UniqueIdentifier, value: versionId },
      ],
    );
    const draft = drafts[0];
    if (!draft) return { status: 409, jsonBody: { error: "That draft is not there any more: it was published or replaced." } };
    const roles = await readCallerRoles(request);
    if (roles === null) return serviceUnavailableResponse();
    if (!canReadProcedure(roles, splitAudience(draft.Audience))) return outsideAudienceResponse();
    if (!hasContent(draft.BlocksJson)) return { status: 409, jsonBody: { error: "Add some content before asking for approval." } };

    const wait = waitBeforeAskingAgain(draft, approver);
    if (wait !== null) return wait;

    const updated = await executeQuery(
      connection,
      `UPDATE dbo.ProcedureVersions
       SET ApprovalRequestedAt = SYSUTCDATETIME(), ApprovalRequestedBy = @RequestedBy,
           ApprovalRequestedFromUserId = @FromUserId, ApprovalRequestedFromName = @FromName
       OUTPUT INSERTED.ApprovalRequestedAt
       WHERE Slug = @Slug AND VersionId = @VersionId AND Status = 'draft'`,
      [
        { name: "Slug", type: TYPES.NVarChar, value: slug },
        { name: "VersionId", type: TYPES.UniqueIdentifier, value: versionId },
        { name: "RequestedBy", type: TYPES.NVarChar, value: requestedBy },
        { name: "FromUserId", type: TYPES.Int, value: approver.userId },
        { name: "FromName", type: TYPES.NVarChar, value: approver.name },
      ],
    );
    if (updated.length === 0) return { status: 409, jsonBody: { error: "That draft is not there any more: it was published or replaced." } };

    const notified = await notify(approver, requestedBy, String(draft.Title), slug, context);
    const at = updated[0].ApprovalRequestedAt;
    return {
      status: 200,
      jsonBody: {
        approver: { name: approver.name, userId: approver.userId },
        notified,
        ok: true,
        requestedAt: at instanceof Date ? at.toISOString() : at,
      },
    };
  } catch (error: any) {
    context.error("requestProcedureApproval failed:", error.message);
    return errorResponse("Request procedure approval failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("requestProcedureApproval", { authLevel: "anonymous", handler: requestProcedureApproval, methods: ["POST"] });
