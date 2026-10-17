// POST /api/completeJobNextStep   (jobs plan A2)
//
// The person a decision handed its next step to (or anyone in the role it was handed
// to, or a manager and above) marks it done, with an optional note. In ONE
// transaction (jobDecisions/completeService) the step is closed, the job.next_step
// escalation chasing it ends, decision.next_step_done is ledgered and, if nothing else
// is waiting, the Admin / Accounts job moves to Done through the in-house close path.
//
// Body { decisionId, note?, rowVersion? }
//   note         at most 1000 characters; it is the ledger row's reason and is shown in
//                the job's history
//   rowVersion   the decision's, as the screen read it; when sent, a stale one is a 409
//
// 200 { decision: DecisionDto (its nextStep.state is "done"), job: { jobId, status },
//       jobClosed, jobStaysOpen, jobStaysOpenReason }
//   jobStaysOpen says why the job was NOT finished, when it wasn't: "revise" (the
//   person who raised it asks again), "deferred" (a question is still to come back),
//   "pending_request", "other_step", "already_closed", or "refused" (the close path's
//   own reason is in jobStaysOpenReason). Only an approved or denied step finishes a job.
// 400 malformed
// 403 not_next_step_owner (the role gate, or the step is someone else's); ledgered as denied
// 404 not_found, job_not_found
// 409 already_done | step_replaced | no_next_step (each carries the decision), stale
// 429 more than 30 a minute from one person
//
// Gate: the roles that can be asked (COMPLETE_NEXT_STEP_ROLES), then the step's owner
// (a person, or a role) or a manager and above.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { closeConnection, createRequestConnection } from "../db";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import "../escalation/adapters";
import { readBody, resolveCaller, type Caller } from "../escalation/http";
import { completeNextStep } from "../jobDecisions/completeService";
import { toDecisionDto } from "../jobDecisions/dto";
import { decisionErrorResponse, decisionPeople, peopleFor } from "../jobDecisions/http";
import { recordRoleDenial } from "../jobDecisions/refusal";
import { readId } from "../jobDecisions/request";
import { readRowVersion, readStepNote } from "../jobDecisions/respond";
import { COMPLETE_NEXT_STEP_ROLES } from "../jobDecisions/roles";
import { checkRateLimit } from "../rateLimit";

const COMPLETE_RATE_LIMIT = { limit: 30, windowMs: 60_000 };

export async function completeJobNextStep(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roleCheck = await requireRole(request, COMPLETE_NEXT_STEP_ROLES);
  if (roleCheck) {
    await recordRoleDenial(request, token, roleCheck, "complete");
    return roleCheck;
  }

  let connection;
  let caller: Caller | null = null;
  try {
    const body = await readBody(request);
    const decisionId = readId(body.decisionId, "decisionId");
    const note = readStepNote(body.note);
    const rowVersion = body.rowVersion === undefined || body.rowVersion === null || body.rowVersion === "" ? null : readRowVersion(body.rowVersion);

    connection = await createRequestConnection(token);
    caller = await resolveCaller(request, connection);
    if (!caller) return unauthorizedResponse();

    const limit = checkRateLimit(`completeJobNextStep:${caller.actor.userId ?? caller.actor.name}`, COMPLETE_RATE_LIMIT);
    if (!limit.allowed) {
      return { headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) }, jsonBody: { error: "Rate limit exceeded" }, status: 429 };
    }

    const done = await completeNextStep(connection, { actor: caller.actor, roles: caller.viewer.roles }, { decisionId, note, rowVersion });
    const people = await peopleFor(connection, decisionPeople(done.decision));
    return {
      jsonBody: {
        decision: toDecisionDto(done.decision, people, null, new Date()),
        job: { jobId: done.jobId, status: done.jobStatus },
        jobClosed: done.jobClosed,
        jobStaysOpen: done.jobStaysOpen,
        jobStaysOpenReason: done.jobStaysOpenReason,
      },
      status: 200,
    };
  } catch (error: unknown) {
    return decisionErrorResponse(error, context, "completeJobNextStep", caller ?? undefined, connection);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("completeJobNextStep", { methods: ["POST"], authLevel: "anonymous", handler: completeJobNextStep });

