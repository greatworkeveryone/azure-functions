// POST /api/linkJobAsset   Body: { jobId, assetId }
//
// Links a job to an asset (many to many). The asset must be live and in the
// job's building. Idempotent: an existing link is returned with created: false.
// Response: { link: { jobId, assetId, linkedAt, linkedBy }, created }.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import type { Connection } from "tedious";
import { closeConnection, createRequestConnection, executeQuery } from "../db";
import { errorResponse } from "../auth";
import { EDIT_ASSETS_ROLES, parseJobAssetInput, uniqueViolationName } from "../assetRegister";
import {
  authorizeWrite,
  badRequest,
  conflict,
  errorMessage,
  inTransaction,
  notFound,
  readJsonBody,
  txFail,
  txOk,
} from "../assetRegisterSupport";

export async function linkJobAsset(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, EDIT_ASSETS_ROLES);
  if (!auth.ok) return auth.response;

  const body = await readJsonBody(request);
  if (!body) return badRequest("Request body must be a JSON object");
  const parsed = parseJobAssetInput(body);
  if (!parsed.ok) return badRequest(parsed.error);
  const { assetId, jobId } = parsed.value;

  const ids = [
    { name: "JobId", type: TYPES.Int, value: jobId },
    { name: "AssetId", type: TYPES.Int, value: assetId },
  ];

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const conn = connection;
    const outcome = await inTransaction(conn, async () => {
      const jobs = await executeQuery(
        conn,
        `SELECT JobID, BuildingID FROM dbo.Jobs WHERE JobID = @JobId`,
        [ids[0]],
      );
      if (!jobs[0]) return txFail(notFound("Job not found"));
      const assets = await executeQuery(
        conn,
        `SELECT AssetId, BuildingId, ArchivedAt FROM dbo.Assets WHERE AssetId = @AssetId`,
        [ids[1]],
      );
      if (!assets[0]) return txFail(notFound("Asset not found"));
      if (assets[0].ArchivedAt) return txFail(conflict("Archived assets cannot be linked to jobs"));
      if (Number(assets[0].BuildingId) !== Number(jobs[0].BuildingID)) {
        return txFail(badRequest("The asset and the job are in different buildings"));
      }

      const inserted = await executeQuery(
        conn,
        `INSERT INTO dbo.JobAssets (JobId, AssetId, LinkedBy)
         OUTPUT INSERTED.LinkedAt, INSERTED.LinkedBy
         SELECT @JobId, @AssetId, @Caller
          WHERE NOT EXISTS (SELECT 1 FROM dbo.JobAssets WHERE JobId = @JobId AND AssetId = @AssetId)`,
        [...ids, { name: "Caller", type: TYPES.NVarChar, value: auth.caller.name }],
      );
      const link =
        inserted[0] ??
        (
          await executeQuery(
            conn,
            `SELECT LinkedAt, LinkedBy FROM dbo.JobAssets WHERE JobId = @JobId AND AssetId = @AssetId`,
            ids,
          )
        )[0];
      return txOk({
        created: inserted.length > 0,
        link: {
          assetId,
          jobId,
          linkedAt: link?.LinkedAt ? new Date(link.LinkedAt as Date).toISOString() : null,
          linkedBy: (link?.LinkedBy as string | null | undefined) ?? null,
        },
      });
    });
    if (!outcome.ok) return outcome.response;
    return { jsonBody: outcome.value, status: 200 };
  } catch (error) {
    // Two requests racing to create the same link: the loser's PK violation is
    // still "linked".
    if (uniqueViolationName(error) !== null) {
      return { jsonBody: { created: false, link: { assetId, jobId, linkedAt: null, linkedBy: null } }, status: 200 };
    }
    context.error("linkJobAsset failed:", errorMessage(error));
    return errorResponse("Failed to link job and asset", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("linkJobAsset", { authLevel: "anonymous", handler: linkJobAsset, methods: ["POST"] });
