// GET /api/getJobDecisionRequest?jobId=12   (jobs plan A1)
//
// The decision request on a job: the one waiting for an answer if there is one,
// otherwise the newest (so the screen can show how the last one ended), and, while
// it is waiting, the chase behind it: who it is with now, when the people first asked
// are reminded and when it moves up.
//
// 200 { request: RequestDto | null, chase: ChaseDto | null }
//   request is null when the job has never asked for a decision; chase is null
//   unless the request is pending.
// 400 jobId missing; 404 no such job
//
// Gate: whoever may read jobs (READ_DECISION_REQUEST_ROLES, a mirror of
// VIEW_JOBS_ROLES in jobs.ts). Every one of them sees the request.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { closeConnection, createRequestConnection } from "../db";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import "../escalation/adapters";
import { DECISION_PENDING_POLICY } from "../escalation/decisionRows";
import { findLiveEscalation, listActiveUsers } from "../escalation/store";
import { toChaseDto, toRequestDto } from "../jobDecisions/dto";
import { decisionErrorResponse } from "../jobDecisions/http";
import { readId, RequestError } from "../jobDecisions/request";
import { READ_DECISION_REQUEST_ROLES } from "../jobDecisions/roles";
import { findPending, jobBuilding, latestForJob, peopleByIds } from "../jobDecisions/store";

export async function getJobDecisionRequest(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roleCheck = await requireRole(request, READ_DECISION_REQUEST_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const jobId = readId(request.query.get("jobId")?.trim(), "jobId");
    connection = await createRequestConnection(token);
    if (!(await jobBuilding(connection, jobId))) throw new RequestError("job_not_found", "That job doesn't exist.", 404);

    const row = (await findPending(connection, jobId)) ?? (await latestForJob(connection, jobId));
    if (!row) return { jsonBody: { chase: null, request: null }, status: 200 };

    const people = await peopleByIds(connection, row.decisionMakers.userIds);
    const live = row.state === "pending" ? await findLiveEscalation(connection, "job", String(jobId), DECISION_PENDING_POLICY) : null;
    const directory = live ? await listActiveUsers(connection) : [];
    return { jsonBody: { chase: toChaseDto(live, directory, new Date()), request: toRequestDto(row, people) }, status: 200 };
  } catch (error: unknown) {
    return decisionErrorResponse(error, context, "getJobDecisionRequest", undefined, connection);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getJobDecisionRequest", { methods: ["GET"], authLevel: "anonymous", handler: getJobDecisionRequest });
