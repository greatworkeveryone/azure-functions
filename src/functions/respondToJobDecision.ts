// POST /api/respondToJobDecision   (jobs plan A2, "Respond")
//
// A decision-maker answers a pending decision request: an outcome, a rationale and,
// unless the outcome is to defer, a next step owned by a person or a role. That closes
// the question and hands the job on. It is ONE transaction (jobDecisions/respondService):
// the decision, the request marked answered, the request's escalation ended, the job
// reassigned to the step's owner with a line in its history, the job.next_step
// escalation raised for them and the ledger rows (decision.approve | deny | defer |
// revise, with the rationale as the reason) commit or roll back together. After the
// commit the owner of the step is emailed (DEV_EMAIL_OVERRIDE honoured). The person who
// asked is told in the app only, as their request's escalation ends with the outcome:
// not by email.
//
// Body {
//   requestId,
//   rowVersion,                  the request's, as the screen read it; required
//   outcome: "approve" | "deny" | "defer" | "revise",
//   rationale,                   required, at most 2000 characters
//   nextStep?,                   required unless deferring, at most 2000 characters
//   nextStepOwner?: { userId } | { role },   default: the person who raised the job
//   deferUntil?                  YYYY-MM-DD, a working day in Darwin after today; defer only
// }
//
// 200 { request: RequestDto (answered), decision: DecisionDto, job: { jobId, assignedTo,
//       assignedToUserId }, replaced: [decisionId] }
//   decision.nextStep.chase is the job.next_step escalation (its due moment, level and
//   who it is with); null when there is no step or the policy is switched off.
//   replaced lists the earlier decisions whose still-open step this one took over from.
// 400 malformed (code bad_request, outcome_invalid, rationale_required, next_step_required,
//     defer_until_required, defer_until_invalid, unexpected_defer_until)
// 403 not_a_decision_maker (the role gate, or the request is not for you: the named list,
//     or the role you hold now; the person who asked is never one); ledgered as denied
// 404 not_found, job_not_found
// 409 not_pending (already answered or withdrawn; carries the request, and the decision
//     when answered), stale (carries the request), job_closed
// 422 defer_until_past | defer_until_not_a_working_day | defer_until_too_far,
//     next_step_owner_unknown | next_step_owner_role_not_allowed | next_step_owner_role_empty |
//     next_step_owner_required (no owner given and the job's creator cannot be found)
// 429 more than 30 a minute from one person
//
// Gate: the roles that can be asked (RESPOND_TO_DECISION_ROLES), then the request's own
// list of who may answer it.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { closeConnection, createRequestConnection } from "../db";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import "../escalation/adapters";
import { readBody, resolveCaller, type Caller } from "../escalation/http";
import { toChaseDto, toDecisionDto, toRequestDto } from "../jobDecisions/dto";
import { decisionErrorResponse, decisionPeople, peopleFor } from "../jobDecisions/http";
import { recordRoleDenial } from "../jobDecisions/refusal";
import { parseRespondBody } from "../jobDecisions/respond";
import { respondDecision } from "../jobDecisions/respondService";
import { RESPOND_TO_DECISION_ROLES } from "../jobDecisions/roles";
import { checkRateLimit } from "../rateLimit";

const RESPOND_RATE_LIMIT = { limit: 30, windowMs: 60_000 };

export async function respondToJobDecision(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roleCheck = await requireRole(request, RESPOND_TO_DECISION_ROLES);
  if (roleCheck) {
    await recordRoleDenial(request, token, roleCheck, "respond");
    return roleCheck;
  }

  let connection;
  let caller: Caller | null = null;
  try {
    const parsed = parseRespondBody(await readBody(request));

    connection = await createRequestConnection(token);
    caller = await resolveCaller(request, connection);
    if (!caller) return unauthorizedResponse();

    const limit = checkRateLimit(`respondToJobDecision:${caller.actor.userId ?? caller.actor.name}`, RESPOND_RATE_LIMIT);
    if (!limit.allowed) {
      return { headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) }, jsonBody: { error: "Rate limit exceeded" }, status: 429 };
    }

    const answered = await respondDecision(connection, { actor: caller.actor, roles: caller.viewer.roles }, parsed);
    const now = new Date();
    const people = await peopleFor(connection, [...answered.request.decisionMakers.userIds, ...decisionPeople(answered.decision)]);
    return {
      jsonBody: {
        decision: toDecisionDto(answered.decision, people, toChaseDto(answered.chase, answered.users, now), now),
        job: answered.job,
        replaced: answered.replaced.map((decision) => decision.decisionId),
        request: toRequestDto(answered.request, people),
      },
      status: 200,
    };
  } catch (error: unknown) {
    return decisionErrorResponse(error, context, "respondToJobDecision", caller ?? undefined, connection);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("respondToJobDecision", { methods: ["POST"], authLevel: "anonymous", handler: respondToJobDecision });
