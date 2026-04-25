// Job Requested Contractors — tracks which contractors have been requested for a job
// before a PO is raised. Facilities staff add/remove contractors here; the list
// drives contractor selection when creating POs.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import {
  beginTransaction,
  closeConnection,
  commitTransaction,
  createConnection,
  executeQuery,
  rollbackTransaction,
} from "../db";
import { extractToken, unauthorizedResponse, errorResponse } from "../auth";

interface AddJobRequestedContractorBody {
  jobId: number;
  contractorId?: number;
  contractorName: string;
  addedBy?: string;
}

interface RemoveJobRequestedContractorBody {
  id: number;
  jobId: number;
}

const REQUESTED_CONTRACTOR_COLUMNS = `
  ID, JobID, ContractorID, ContractorName, AddedAt, AddedBy
`;

// ── GET /api/getJobRequestedContractors?jobId=N ──────────────────────────────

async function getJobRequestedContractors(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const jobId = request.query.get("jobId");
  if (!jobId) {
    return { status: 400, jsonBody: { error: "jobId query param required" } };
  }

  let connection;
  try {
    connection = await createConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT ${REQUESTED_CONTRACTOR_COLUMNS}
         FROM JobRequestedContractors
        WHERE JobID = @JobID
        ORDER BY AddedAt ASC`,
      [{ name: "JobID", type: TYPES.Int, value: Number(jobId) }],
    );
    return { status: 200, jsonBody: { count: rows.length, requestedContractors: rows } };
  } catch (error: any) {
    context.error("getJobRequestedContractors failed:", error.message);
    return errorResponse("Failed to fetch requested contractors", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/addJobRequestedContractor ──────────────────────────────────────
// Body: { jobId, contractorId?, contractorName, addedBy? }

async function addJobRequestedContractor(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as AddJobRequestedContractorBody;
    const { jobId, contractorId, contractorName, addedBy } = body ?? {};

    if (typeof jobId !== "number") {
      return { status: 400, jsonBody: { error: "jobId (number) required" } };
    }
    if (!contractorName || typeof contractorName !== "string") {
      return { status: 400, jsonBody: { error: "contractorName (string) required" } };
    }

    connection = await createConnection(token);

    await beginTransaction(connection);
    try {
      // Check whether this is the first contractor being requested so we can
      // transition the job to Quote status.
      const existingRows = await executeQuery(
        connection,
        "SELECT COUNT(*) AS Cnt FROM JobRequestedContractors WHERE JobID = @JobID",
        [{ name: "JobID", type: TYPES.Int, value: jobId }],
      );
      const isFirst = (existingRows[0].Cnt as number) === 0;

      const inserted = await executeQuery(
        connection,
        `INSERT INTO JobRequestedContractors (JobID, ContractorID, ContractorName, AddedBy)
         OUTPUT INSERTED.ID
         VALUES (@JobID, @ContractorID, @ContractorName, @AddedBy);`,
        [
          { name: "JobID", type: TYPES.Int, value: jobId },
          { name: "ContractorID", type: TYPES.Int, value: contractorId ?? null },
          { name: "ContractorName", type: TYPES.NVarChar, value: contractorName },
          { name: "AddedBy", type: TYPES.NVarChar, value: addedBy ?? null },
        ],
      );
      const newId = inserted[0].ID as number;

      await executeQuery(
        connection,
        `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType)
         VALUES (@JobID, @CreatedBy, @Text, 'contractor_requested');`,
        [
          { name: "JobID", type: TYPES.Int, value: jobId },
          { name: "CreatedBy", type: TYPES.NVarChar, value: addedBy ?? null },
          { name: "Text", type: TYPES.NVarChar, value: `Requested ${contractorName}` },
        ],
      );

      // First contractor added → transition job from New to Quote so it
      // surfaces in the Quote bucket while waiting for responses.
      if (isFirst) {
        await executeQuery(
          connection,
          `UPDATE Jobs
           SET Status = 'Quote', AwaitingRole = 'facilities', LastModifiedDate = SYSUTCDATETIME()
           WHERE JobID = @JobID AND Status = 'New';
           INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, NewStatus, NewAwaitingRole)
           SELECT @JobID, @CreatedBy, 'Contractors requested — awaiting quotes.', 'status_change', 'Quote', 'facilities'
           WHERE @@ROWCOUNT > 0;`,
          [
            { name: "JobID", type: TYPES.Int, value: jobId },
            { name: "CreatedBy", type: TYPES.NVarChar, value: addedBy ?? null },
          ],
        );
      } else {
        await executeQuery(
          connection,
          "UPDATE Jobs SET LastModifiedDate = SYSUTCDATETIME() WHERE JobID = @JobID",
          [{ name: "JobID", type: TYPES.Int, value: jobId }],
        );
      }

      await commitTransaction(connection);

      const stored = await executeQuery(
        connection,
        `SELECT ${REQUESTED_CONTRACTOR_COLUMNS}
           FROM JobRequestedContractors
          WHERE ID = @ID`,
        [{ name: "ID", type: TYPES.Int, value: newId }],
      );
      return { status: 200, jsonBody: { requestedContractor: stored[0] } };
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }
  } catch (error: any) {
    context.error("addJobRequestedContractor failed:", error.message);
    return errorResponse("Failed to add requested contractor", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/removeJobRequestedContractor ───────────────────────────────────
// Body: { id, jobId }

async function removeJobRequestedContractor(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as RemoveJobRequestedContractorBody;
    const { id, jobId } = body ?? {};

    if (typeof id !== "number") {
      return { status: 400, jsonBody: { error: "id (number) required" } };
    }
    if (typeof jobId !== "number") {
      return { status: 400, jsonBody: { error: "jobId (number) required" } };
    }

    connection = await createConnection(token);

    const rows = await executeQuery(
      connection,
      `SELECT ContractorName FROM JobRequestedContractors WHERE ID = @ID AND JobID = @JobID`,
      [
        { name: "ID", type: TYPES.Int, value: id },
        { name: "JobID", type: TYPES.Int, value: jobId },
      ],
    );
    if (rows.length === 0) {
      return { status: 404, jsonBody: { error: "Requested contractor not found" } };
    }
    const contractorName = rows[0].ContractorName as string;

    await beginTransaction(connection);
    try {
      await executeQuery(
        connection,
        `DELETE FROM JobRequestedContractors WHERE ID = @ID AND JobID = @JobID`,
        [
          { name: "ID", type: TYPES.Int, value: id },
          { name: "JobID", type: TYPES.Int, value: jobId },
        ],
      );

      await executeQuery(
        connection,
        `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType)
         VALUES (@JobID, NULL, @Text, 'contractor_request_removed');`,
        [
          { name: "JobID", type: TYPES.Int, value: jobId },
          { name: "Text", type: TYPES.NVarChar, value: `Removed contractor request for ${contractorName}` },
        ],
      );
      await executeQuery(
        connection,
        "UPDATE Jobs SET LastModifiedDate = SYSUTCDATETIME() WHERE JobID = @JobID",
        [{ name: "JobID", type: TYPES.Int, value: jobId }],
      );

      await commitTransaction(connection);
      return { status: 200, jsonBody: { deleted: true, id } };
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }
  } catch (error: any) {
    context.error("removeJobRequestedContractor failed:", error.message);
    return errorResponse("Failed to remove requested contractor", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getJobRequestedContractors", {
  methods: ["GET"],
  authLevel: "anonymous",
  handler: getJobRequestedContractors,
});
app.http("addJobRequestedContractor", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: addJobRequestedContractor,
});
app.http("removeJobRequestedContractor", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: removeJobRequestedContractor,
});
