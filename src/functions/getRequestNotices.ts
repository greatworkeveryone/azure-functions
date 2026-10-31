// GET /api/getRequestNotices?workRequestId=31   (or ?jobId=12)
//
// The status notices sent, or owed, to the tenant for one request (TR4, PLAN §15): which event, how it stands, when
// and to whom. Read-only, from dbo.TenantNotices. Same roles as the intake state (ACTION_ROLES.viewRequestIntake);
// the app asks only with the tenantRequests flag on. Before migration 186 is applied it answers an empty list.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES, type Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { authorizeWrite, badRequest } from "../assetRegisterSupport";
import { errorResponse } from "../auth";
import { closeConnection, createRequestConnection, executeQuery, type SqlRow } from "../db";
import { READ_LIMIT, tooManyRequests } from "../inboundTriage/limits";
import { checkRateLimit } from "../rateLimit";
import { iso, trimmedOrNull as str } from "../sqlHelpers";
import { parseWorkRequestId } from "../workRequestsNative";

const MISSING_TABLE = /Invalid object name 'dbo\.TenantNotices'/i;
const whole = (raw: string | null): number | null => (raw !== null && /^[1-9]\d{0,9}$/.test(raw) && Number(raw) <= 2_147_483_647 ? Number(raw) : null);

export async function getRequestNotices(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, ACTION_ROLES.viewRequestIntake.gate);
  if (!auth.ok) return auth.response;
  const limited = checkRateLimit(`getRequestNotices:${auth.caller.oid}`, READ_LIMIT);
  if (!limited.allowed) return tooManyRequests(limited.retryAfterMs);
  const workRequestId = parseWorkRequestId(request.query.get("workRequestId"));
  const jobId = whole(request.query.get("jobId"));
  if ((workRequestId === null) === (jobId === null)) return badRequest("Give either workRequestId or jobId, as a whole number");

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    let rows: SqlRow[];
    try {
      rows = await executeQuery(
        connection,
        `SELECT TOP (50) NoticeId, JobId, WorkRequestId, Event, Status, Detail, RecipientsText, CreatedAt, ProcessedAt
           FROM dbo.TenantNotices
          WHERE (@ByRequest = 1 AND WorkRequestId = @Id) OR (@ByRequest = 0 AND JobId = @Id)
          ORDER BY NoticeId`,
        [
          { name: "Id", type: TYPES.Int, value: workRequestId ?? (jobId as number) },
          { name: "ByRequest", type: TYPES.Bit, value: workRequestId === null ? 0 : 1 },
        ],
      );
    } catch (error) {
      if (!MISSING_TABLE.test(error instanceof Error ? error.message : String(error))) throw error;
      rows = [];
    }
    const items = rows.map((row) => ({
      createdAt: iso(row.CreatedAt),
      detail: str(row.Detail),
      event: String(row.Event),
      jobId: Number(row.JobId),
      noticeId: Number(row.NoticeId),
      processedAt: iso(row.ProcessedAt),
      recipients: str(row.RecipientsText),
      status: String(row.Status),
      workRequestId: row.WorkRequestId === null || row.WorkRequestId === undefined ? null : Number(row.WorkRequestId),
    }));
    return { headers: { "Cache-Control": "no-store" }, jsonBody: { items }, status: 200 };
  } catch (error) {
    context.error("getRequestNotices failed:", error instanceof Error ? error.message : error);
    return errorResponse("Could not load the notices for this request", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getRequestNotices", { authLevel: "anonymous", handler: getRequestNotices, methods: ["GET"] });
