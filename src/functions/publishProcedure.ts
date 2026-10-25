// POST /api/publishProcedure   { slug, versionId, reviewIntervalMonths }
//
// Promotes a draft, stamping the approver FROM THE TOKEN, never from the body, because
// "who approved this" is the assurance the endpoint exists to provide. A director
// publishes; admin alone does not (requireProcedureApprover).
//
// The draft is read and locked first, and nothing is archived unless it is still
// there. A second Publish of the same draft (two directors asked, two tabs, a retry
// after a timeout) finds no draft, answers 409 and changes nothing: before, it
// archived the version the first one had just published, promoted nothing and
// committed, and the procedure vanished for staff. If the promotion still changes
// nothing, the transaction is rolled back, not committed.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import {
  beginTransaction,
  closeConnection,
  commitTransaction,
  createRequestConnection,
  executeQuery,
  rollbackTransaction,
} from "../db";
import { errorResponse, extractToken, unauthorizedResponse, userInfoFromToken } from "../auth";
import { requireProcedureApprover, readCallerRoles } from "../procedureAccess";
import { canEndorseProcedure } from "../procedureEndorsement";
import { splitAudience } from "../procedureLibrary";
import { REVIEW_INTERVALS } from "../procedureLibrary";

const NO_DRAFT: HttpResponseInit = {
  jsonBody: { error: "No matching draft to publish: it was already published or replaced." },
  status: 409,
};

export async function publishProcedure(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  // Narrower than editing: writing an SOP and putting it into force are different acts.
  const denied = await requireProcedureApprover(request);
  if (denied) return denied;

  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  let inTransaction = false;
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
    await beginTransaction(connection);
    inTransaction = true;

    const key = [
      { name: "Slug", type: TYPES.NVarChar, value: slug },
      { name: "VersionId", type: TYPES.UniqueIdentifier, value: versionId },
    ];

    const policy = await executeQuery(connection,
      "SELECT Audience, EndorsementAuthority FROM dbo.Procedures WITH (UPDLOCK, HOLDLOCK) WHERE Slug = @Slug",
      [{ name: "Slug", type: TYPES.NVarChar, value: slug }]);
    const roles = await readCallerRoles(request);
    if (roles === null || !policy[0] || !canEndorseProcedure(roles, splitAudience(policy[0].Audience), String(policy[0].EndorsementAuthority ?? "team"))) {
      await rollbackTransaction(connection);
      inTransaction = false;
      return { status: roles === null ? 503 : 403, jsonBody: { error: "This procedure requires endorsement by its team manager or the CFO/director, according to its authority setting." } };
    }

    // Read and lock the draft first: nothing is archived unless it is still there.
    const drafts = await executeQuery(
      connection,
      `SELECT VersionId FROM dbo.ProcedureVersions WITH (UPDLOCK, ROWLOCK)
       WHERE Slug = @Slug AND VersionId = @VersionId AND Status = 'draft'`,
      key,
    );
    if (drafts.length === 0) {
      await rollbackTransaction(connection);
      inTransaction = false;
      return NO_DRAFT;
    }

    // Retire the incumbent first: the one-published filtered index would
    // otherwise reject the promotion below.
    await executeQuery(
      connection,
      `UPDATE dbo.ProcedureVersions SET Status = 'archived' WHERE Slug = @Slug AND Status = 'published'`,
      [{ name: "Slug", type: TYPES.NVarChar, value: slug }],
    );

    const promoted = await executeQuery(
      connection,
      `UPDATE dbo.ProcedureVersions
       SET Status = 'published',
           ApprovedBy = @Approver,
           ApprovedAt = SYSUTCDATETIME(),
           PublishedAt = SYSUTCDATETIME(),
           ReviewDue = CASE WHEN @Months = 0 THEN NULL ELSE CAST(DATEADD(MONTH, @Months, SYSUTCDATETIME()) AS DATE) END
       OUTPUT INSERTED.VersionId
       WHERE Slug = @Slug AND VersionId = @VersionId AND Status = 'draft'`,
      [...key, { name: "Approver", type: TYPES.NVarChar, value: approverName }, { name: "Months", type: TYPES.Int, value: months }],
    );
    if (promoted.length === 0) {
      await rollbackTransaction(connection);
      inTransaction = false;
      return NO_DRAFT;
    }

    await commitTransaction(connection);
    inTransaction = false;
    return { status: 200, jsonBody: { ok: true } };
  } catch (error: any) {
    if (connection && inTransaction) await rollbackTransaction(connection).catch(() => undefined);
    context.error("publishProcedure failed:", error.message);
    return errorResponse("Publish procedure failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("publishProcedure", { methods: ["POST"], authLevel: "anonymous", handler: publishProcedure });
