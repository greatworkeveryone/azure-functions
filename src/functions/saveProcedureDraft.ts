// POST /api/saveProcedureDraft   { slug, title, summary, blocks, category?, audience?, updatedAt? }
//
// Never touches a published row: it updates the single draft or creates one at the
// next version number, creating the parent dbo.Procedures row on first save of a
// new slug. An edit withdraws any request for approval (migration 142): what was
// asked about is gone.
//
// Optional `updatedAt` (alias `version`): the draft's updatedAt as last read (the
// value this endpoint and getProcedures' createdAt return). When sent and the draft
// has since been saved, published or removed, nothing is written and the answer is
// 409 with the current updatedAt. Omitted, the save is last-writer-wins as before.
// The response carries the new updatedAt and approvalRequestCleared (true when the
// save withdrew a pending request for approval).
//
// An editor writes for their own team: a draft of a procedure written for another
// team, or a new procedure for another team, is refused (403) before anything is
// written. Director and admin write for any audience (procedureAudience.ts).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { closeConnection, createRequestConnection, executeQuery } from "../db";
import { errorResponse, extractToken, requireRole, serviceUnavailableResponse, unauthorizedResponse, userInfoFromToken } from "../auth";
import { outsideAudienceResponse, readCallerRoles, storedAudience } from "../procedureAccess";
import { canReadProcedure } from "../procedureAudience";
import { KNOWN_AUDIENCES, MAX_BLOCKS_BYTES, validateBlocks } from "../procedureLibrary";
import { PROCEDURE_EDITOR_GATE } from "../procedureRoles";

export async function saveProcedureDraft(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const denied = await requireRole(request, PROCEDURE_EDITOR_GATE);
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
    const written = audience.length > 0 ? audience : ["all"];

    const rawToken = body?.updatedAt ?? body?.version;
    const expectedAt = rawToken === undefined || rawToken === null ? null : new Date(String(rawToken));
    if (expectedAt !== null && Number.isNaN(expectedAt.getTime())) {
      return { status: 400, jsonBody: { error: "updatedAt must be the date-time of the draft you were shown" } };
    }

    const author = userInfoFromToken(token);

    connection = await createRequestConnection(token);
    const roles = await readCallerRoles(request);
    if (roles === null) return serviceUnavailableResponse();
    // An existing procedure keeps the audience it was made with; a new one is made with the one asked for.
    const audienceInForce = (await storedAudience(connection, slug)) ?? written;
    if (!canReadProcedure(roles, audienceInForce)) {
      const policy = roles.includes("cfo") ? await executeQuery(connection, "SELECT EndorsementAuthority FROM dbo.Procedures WHERE Slug=@Slug", [{ name: "Slug", type: TYPES.NVarChar, value: slug }]) : [];
      if (policy[0]?.EndorsementAuthority !== "executive") return outsideAudienceResponse();
    }

    const rows = await executeQuery(
      connection,
      `SET XACT_ABORT ON;
       BEGIN TRANSACTION;

       IF NOT EXISTS (SELECT 1 FROM dbo.Procedures WHERE Slug = @Slug)
         INSERT INTO dbo.Procedures (Slug, Category, Audience, SortOrder)
         SELECT @Slug, @Category, @Audience,
                ISNULL((SELECT MAX(SortOrder) FROM dbo.Procedures), 0) + 1;

       -- The draft as it stands, held until commit: its save time and whether a request is pending.
       DECLARE @PrevAt DATETIME2(0), @HadRequest BIT = 0;
       SELECT @PrevAt = CreatedAt, @HadRequest = CASE WHEN ApprovalRequestedAt IS NULL THEN 0 ELSE 1 END
       FROM dbo.ProcedureVersions WITH (UPDLOCK, HOLDLOCK) WHERE Slug = @Slug AND Status = 'draft';

       IF @ExpectedAt IS NOT NULL AND (@PrevAt IS NULL OR @PrevAt <> CAST(@ExpectedAt AS DATETIME2(0)))
       BEGIN
         ROLLBACK TRANSACTION;
         SELECT 'conflict' AS Outcome, @PrevAt AS UpdatedAt, CAST(0 AS BIT) AS ApprovalRequestCleared;
         RETURN;
       END

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

       SELECT 'ok' AS Outcome, CreatedAt AS UpdatedAt, @HadRequest AS ApprovalRequestCleared
       FROM dbo.ProcedureVersions WHERE Slug = @Slug AND Status = 'draft';

       COMMIT TRANSACTION;`,
      [
        { name: "Slug", type: TYPES.NVarChar, value: slug },
        { name: "Category", type: TYPES.NVarChar, value: category },
        { name: "Audience", type: TYPES.NVarChar, value: written.join(",") },
        { name: "Title", type: TYPES.NVarChar, value: title },
        { name: "Summary", type: TYPES.NVarChar, value: summary },
        { name: "Blocks", type: TYPES.NVarChar, value: blocksJson },
        { name: "Author", type: TYPES.NVarChar, value: author?.name ?? author?.email ?? "Unknown" },
        { name: "ExpectedAt", type: TYPES.DateTime2, value: expectedAt },
      ],
    );

    const outcome = rows[0];
    const updatedAt = outcome?.UpdatedAt instanceof Date ? outcome.UpdatedAt.toISOString() : null;
    if (outcome?.Outcome === "conflict") {
      return {
        status: 409,
        jsonBody: { current: { updatedAt }, error: "This draft was saved by someone else, or published, since you opened it. Reload to see it as it is now." },
      };
    }
    return { status: 200, jsonBody: { approvalRequestCleared: outcome?.ApprovalRequestCleared === true, ok: true, updatedAt } };
  } catch (error: any) {
    context.error("saveProcedureDraft failed:", error.message);
    return errorResponse("Save procedure draft failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("saveProcedureDraft", { methods: ["POST"], authLevel: "anonymous", handler: saveProcedureDraft });
