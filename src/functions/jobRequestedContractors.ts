// Job Requested Contractors — tracks which contractors have been requested for a job
// before a PO is raised. Facilities staff add/remove contractors here; the list
// drives contractor selection when creating POs.

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
import { AppRole, extractToken, requireRole, unauthorizedResponse, errorResponse, verifiedIdentityFromRequest } from "../auth";
import { ACTION_ROLES } from "../action-roles";
import { advanceJobStatus } from "../jobStatusHelpers";
import { JobEvent } from "../jobStatusMachine";

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

interface ToggleRequestedContractorSentBody {
  id: number;
  jobId: number;
  requestSent: boolean;
}

interface MarkRequestedContractorsSentBody {
  jobId: number;
  ids: number[];
}

const MAX_MARK_SENT_IDS = 50;

const REQUESTED_CONTRACTOR_COLUMNS = `
  ID, JobID, ContractorID, ContractorName, AddedAt, AddedBy, RequestSent
`;

// The person pressing the button, from the verified token. Null (never a
// client-supplied name) when the token cannot be verified; the role gate has
// already passed by then.
async function actorFromRequest(request: HttpRequest): Promise<string | null> {
  const identity = await verifiedIdentityFromRequest(request).catch(() => null);
  return identity?.name ?? null;
}

// Quote request went out: one 'quote_requested' event naming who it went to,
// then the New → Quote move (a no-op when the job is already past New).
// Caller owns the transaction.
async function recordQuoteRequestSent(
  connection: any,
  jobId: number,
  contractorNames: string[],
  actor: string | null,
): Promise<void> {
  const text = `Quote request sent to ${contractorNames.join(", ")}`;
  await executeQuery(
    connection,
    `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType)
     VALUES (@JobID, @CreatedBy, @Text, 'quote_requested');`,
    [
      { name: "JobID", type: TYPES.Int, value: jobId },
      { name: "CreatedBy", type: TYPES.NVarChar, value: actor },
      { name: "Text", type: TYPES.NVarChar, value: text },
    ],
  );
  await advanceJobStatus(connection, jobId, JobEvent.QUOTE_REQUESTED, {
    actor,
    note: `${text} — awaiting quotes.`,
  });
}

// ── GET /api/getJobRequestedContractors?jobId=N ──────────────────────────────

async function getJobRequestedContractors(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  // Accounts also need to see the requested-contractor list — they own the
  // invoice/PO workflows that key off contractor identity, and the Quotes
  // step's read-only summary surfaces this list to them.
  const denied = await requireRole(request, [AppRole.ACCOUNTS, AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL]);
  if (denied) return denied;

  const jobId = request.query.get("jobId");
  if (!jobId) {
    return { status: 400, jsonBody: { error: "jobId query param required" } };
  }

  let connection;
  try {
    connection = await createRequestConnection(token);
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

  // Accounts can drive the quote-request flow too — when work originates
  // from a tenancy enquiry they often add the contractor themselves rather
  // than waiting on a facilities manager.
  const denied = await requireRole(request, ACTION_ROLES.addQuoteContractor.gate);
  if (denied) return denied;

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

    connection = await createRequestConnection(token);

    await beginTransaction(connection);
    try {
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
          { name: "Text", type: TYPES.NVarChar, value: `Added ${contractorName} to the quote request` },
        ],
      );

      // Adding a contractor does not move the job: nothing has been sent yet.
      // The job reads Quote once the request is marked sent.
      await executeQuery(
        connection,
        "UPDATE Jobs SET LastModifiedDate = SYSUTCDATETIME() WHERE JobID = @JobID",
        [{ name: "JobID", type: TYPES.Int, value: jobId }],
      );

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

  // Mirrors addJobRequestedContractor — whoever can add can also undo.
  const denied = await requireRole(request, ACTION_ROLES.addQuoteContractor.gate);
  if (denied) return denied;

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

    connection = await createRequestConnection(token);

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

// ── POST /api/toggleRequestedContractorSent ──────────────────────────────────
// Body: { id, jobId, requestSent }

async function toggleRequestedContractorSent(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  // Same set as add/remove — toggling whether the request email has been
  // sent is part of the same workflow.
  const denied = await requireRole(request, ACTION_ROLES.addQuoteContractor.gate);
  if (denied) return denied;

  let connection;
  try {
    const body = (await request.json()) as ToggleRequestedContractorSentBody;
    const { id, jobId, requestSent } = body ?? {};

    if (typeof id !== "number") {
      return { status: 400, jsonBody: { error: "id (number) required" } };
    }
    if (typeof jobId !== "number") {
      return { status: 400, jsonBody: { error: "jobId (number) required" } };
    }
    if (typeof requestSent !== "boolean") {
      return { status: 400, jsonBody: { error: "requestSent (boolean) required" } };
    }

    connection = await createRequestConnection(token);
    const actor = await actorFromRequest(request);

    await beginTransaction(connection);
    try {
      const before = await executeQuery(
        connection,
        `SELECT ContractorName, RequestSent
           FROM dbo.JobRequestedContractors WITH (UPDLOCK, HOLDLOCK)
          WHERE ID = @ID AND JobID = @JobID`,
        [
          { name: "ID", type: TYPES.Int, value: id },
          { name: "JobID", type: TYPES.Int, value: jobId },
        ],
      );
      if (before.length === 0) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: "Requested contractor not found" } };
      }

      await executeQuery(
        connection,
        `UPDATE dbo.JobRequestedContractors
            SET RequestSent = @RequestSent
          WHERE ID = @ID AND JobID = @JobID`,
        [
          { name: "ID", type: TYPES.Int, value: id },
          { name: "JobID", type: TYPES.Int, value: jobId },
          { name: "RequestSent", type: TYPES.Bit, value: requestSent },
        ],
      );

      // First send moves the job; un-ticking never moves it back.
      if (requestSent && !before[0].RequestSent) {
        await recordQuoteRequestSent(connection, jobId, [before[0].ContractorName as string], actor);
      }

      const updated = await executeQuery(
        connection,
        `SELECT ${REQUESTED_CONTRACTOR_COLUMNS}
           FROM dbo.JobRequestedContractors
          WHERE ID = @ID AND JobID = @JobID`,
        [
          { name: "ID", type: TYPES.Int, value: id },
          { name: "JobID", type: TYPES.Int, value: jobId },
        ],
      );
      await commitTransaction(connection);
      return { status: 200, jsonBody: { requestedContractor: updated[0] } };
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }
  } catch (error: any) {
    context.error("toggleRequestedContractorSent failed:", error.message);
    return errorResponse("Failed to update request status", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/markRequestedContractorsSent ───────────────────────────────────
// Body: { jobId, ids } (1 to 50 ids, all this job's). Marks them sent, logs ONE
// 'quote_requested' event, and moves the job New → Quote (no-op past New).

async function markRequestedContractorsSent(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, ACTION_ROLES.addQuoteContractor.gate);
  if (denied) return denied;

  let connection;
  try {
    const body = (await request.json()) as MarkRequestedContractorsSentBody;
    const { jobId, ids } = body ?? {};

    if (typeof jobId !== "number") {
      return { status: 400, jsonBody: { error: "jobId (number) required" } };
    }
    if (
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > MAX_MARK_SENT_IDS ||
      !ids.every((n) => Number.isInteger(n))
    ) {
      return { status: 400, jsonBody: { error: `ids (1 to ${MAX_MARK_SENT_IDS} integers) required` } };
    }
    const uniqueIds = Array.from(new Set(ids));

    connection = await createRequestConnection(token);
    const actor = await actorFromRequest(request);

    await beginTransaction(connection);
    try {
      // Ids are integers (validated above), so the list is safe to inline.
      const idList = uniqueIds.join(",");
      const found = await executeQuery(
        connection,
        `SELECT ID, ContractorName
           FROM dbo.JobRequestedContractors WITH (UPDLOCK, HOLDLOCK)
          WHERE JobID = @JobID AND ID IN (${idList})
          ORDER BY AddedAt ASC, ID ASC`,
        [{ name: "JobID", type: TYPES.Int, value: jobId }],
      );
      if (found.length !== uniqueIds.length) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: "Requested contractor not found for this job" } };
      }

      await executeQuery(
        connection,
        `UPDATE dbo.JobRequestedContractors
            SET RequestSent = 1
          WHERE JobID = @JobID AND ID IN (${idList})`,
        [{ name: "JobID", type: TYPES.Int, value: jobId }],
      );
      await recordQuoteRequestSent(
        connection,
        jobId,
        found.map((r) => r.ContractorName as string),
        actor,
      );
      const rows = await executeQuery(
        connection,
        `SELECT ${REQUESTED_CONTRACTOR_COLUMNS}
           FROM dbo.JobRequestedContractors
          WHERE JobID = @JobID AND ID IN (${idList})
          ORDER BY AddedAt ASC, ID ASC`,
        [{ name: "JobID", type: TYPES.Int, value: jobId }],
      );
      await commitTransaction(connection);
      return { status: 200, jsonBody: { requestedContractors: rows } };
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }
  } catch (error: any) {
    context.error("markRequestedContractorsSent failed:", error.message);
    return errorResponse("Failed to mark quote requests sent", error.message);
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
app.http("toggleRequestedContractorSent", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: toggleRequestedContractorSent,
});
app.http("markRequestedContractorsSent", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: markRequestedContractorsSent,
});
