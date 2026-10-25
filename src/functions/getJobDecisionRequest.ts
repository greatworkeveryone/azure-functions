// GET /api/getJobDecisionRequest?jobId=12   (jobs plan A1, extended by A2)
//
// The decision request on a job: the one waiting for an answer if there is one,
// otherwise the newest (so the screen can show how the last one ended). While it is
// waiting, the chase behind it: who it is with now, when the people first asked are
// reminded and when it moves up. Once it is answered, the answer and the state of the
// next step it handed on.
//
// 200 { request: RequestDto | null, chase: ChaseDto | null,
//       decision: DecisionDto | null, previousDecision: DecisionDto | null }
//   request is null when the job has never asked for a decision; chase is null unless
//   the request is pending.
//   decision is the answer to `request`: its outcome, rationale and who gave it, the
//   next step (text, owner, due moment, state "open" | "done" | "replaced", who closed
//   it and the note, and while it is open the chase on it: level, who it is with, when it
//   moves up) and, for a deferral, the day the question comes back and, once it has, the
//   request it came back as. Null while `request` is pending or was withdrawn.
//   previousDecision is, while `request` is pending, the newest answer given on this job
//   before it (a deferral this request is the second asking of, or the revisions it
//   follows), so the person answering can see how it got here. Otherwise null.
// 400 jobId missing; 404 no such job
//
// Gate: whoever may read jobs (READ_DECISION_REQUEST_ROLES, a mirror of
// VIEW_JOBS_ROLES in jobs.ts). Every one of them sees the request.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { closeConnection, createRequestConnection } from "../db";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import "../escalation/adapters";
import { DECISION_PENDING_POLICY, NEXT_STEP_POLICY, nextStepOf } from "../escalation/decisionRows";
import { findLiveEscalation, listActiveUsers } from "../escalation/store";
import type { DirectoryUser, EscalationRow } from "../escalation/types";
import { decisionForRequest, latestDecisionForJob, type DecisionRow } from "../jobDecisions/decisionsStore";
import { toChaseDto, toDecisionDto, toRequestDto, type ChaseDto } from "../jobDecisions/dto";
import { decisionErrorResponse, decisionPeople } from "../jobDecisions/http";
import { readId, RequestError } from "../jobDecisions/request";
import { READ_DECISION_REQUEST_ROLES } from "../jobDecisions/roles";
import { findPending, jobBuilding, latestForJob, peopleByIds } from "../jobDecisions/store";

/** The chase on a decision's next step, while it is open: the live job.next_step
 *  escalation, if it is the one for this decision. */
function stepChase(decision: DecisionRow | null, live: EscalationRow | null, directory: readonly DirectoryUser[], now: Date): ChaseDto | null {
  if (!decision || decision.nextStep === null || decision.nextStepClosed || !live) return null;
  return nextStepOf(live)?.decisionId === decision.decisionId ? toChaseDto(live, directory, now) : null;
}

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
    if (!row) return { jsonBody: { chase: null, decision: null, previousDecision: null, request: null }, status: 200 };

    const now = new Date();
    const answered = row.state === "answered" ? await decisionForRequest(connection, row.requestId) : null;
    const previous = row.state === "pending" ? await latestDecisionForJob(connection, jobId) : null;
    const live = row.state === "pending" ? await findLiveEscalation(connection, "job", String(jobId), DECISION_PENDING_POLICY) : null;
    const wantsStep = [answered, previous].some((decision) => decision && decision.nextStep !== null && !decision.nextStepClosed);
    const liveStep = wantsStep ? await findLiveEscalation(connection, "job", String(jobId), NEXT_STEP_POLICY) : null;
    const directory = live || liveStep ? await listActiveUsers(connection) : [];

    const named = [...row.decisionMakers.userIds, ...(answered ? decisionPeople(answered) : []), ...(previous ? decisionPeople(previous) : [])];
    const people = await peopleByIds(connection, named.filter((id): id is number => id !== null));
    return {
      jsonBody: {
        chase: toChaseDto(live, directory, now),
        decision: answered ? toDecisionDto(answered, people, stepChase(answered, liveStep, directory, now), now) : null,
        previousDecision: previous ? toDecisionDto(previous, people, stepChase(previous, liveStep, directory, now), now) : null,
        request: toRequestDto(row, people),
      },
      status: 200,
    };
  } catch (error: unknown) {
    return decisionErrorResponse(error, context, "getJobDecisionRequest", undefined, connection);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getJobDecisionRequest", { methods: ["GET"], authLevel: "anonymous", handler: getJobDecisionRequest });
