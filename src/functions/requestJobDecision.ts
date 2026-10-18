// POST /api/requestJobDecision   (jobs plan A1, "Ask")
//
// An Admin / Accounts job asks for a decision: a question put to named people or to
// everyone in a role, with an urgency tier that sets when an answer is due, when the
// people are reminded and when it moves up to the raiser's manager (jobDecisions/
// tiers.ts). It is ONE transaction: the request, the escalation that chases it and
// the ledger rows (decision.requested, and escalation.raise beside it) commit or roll
// back together. After the commit each person asked is emailed through the
// escalation engine's notifier (DEV_EMAIL_OVERRIDE honoured), and the request
// appears in their escalation inbox and badge.
//
// Body {
//   jobId, question,
//   assignmentMode: "named" | "role",
//   decisionMakers: { userIds: [3, 5] }  |  { role: "accounts_manager" },
//   tier: "emergency" | "urgent" | "soon" | "routine" | "fixed",
//   autoEscalate?   urgent only: true moves it up to the raiser's manager at the 36-hour
//                   mark; absent or false (the default) never moves it up, though the
//                   24-hour reminder still goes. soon / routine / fixed always move up
//                   and refuse false (400 auto_escalate_not_optional); an emergency
//                   ignores it
//   routineWeeks?   2 to 8, routine only
//   fixedDate?      "YYYY-MM-DD", a Darwin working day, fixed only
//   sourceAttachmentId?   a file on this job
// }
//
// 201 { request: RequestDto, chase: ChaseDto, callThem }
//   callThem is true for an emergency: nothing is timed or chased, so the screen
//   says "call them". request.autoEscalate says whether it will move up on its own;
//   chase.dueAt is null when it will not (an emergency, or an urgent one not ticked).
// 400 malformed (code bad_request, or a tier code: invalid_tier, routine_weeks_*,
//     fixed_date_required, fixed_date_invalid, unexpected_*, auto_escalate_invalid,
//     auto_escalate_not_optional)
// 403 not a role that may edit jobs
// 404 job_not_found
// 409 already_pending (carries the request that is), job_closed
// 422 not_an_admin_job, attachment_not_on_job, decision_maker_unknown,
//     decision_maker_is_requester, decision_maker_role_not_allowed, role_has_no_one,
//     fixed_date_past, fixed_date_not_a_working_day, fixed_date_too_far,
//     policy_inactive (the job.decision_pending policy is switched off)
// 429 more than 30 a minute from one person
//
// Gate: whoever may create jobs (ASK_FOR_DECISION_ROLES, a mirror of EDIT_JOBS_ROLES
// in jobs.ts); the job must be an Admin / Accounts one.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { closeConnection, createRequestConnection } from "../db";
import { extractToken, requireRole, unauthorizedResponse, verifiedIdentityFromRequest } from "../auth";
import "../escalation/adapters";
import { readBody, resolveCaller, type Caller } from "../escalation/http";
import { toChaseDto, toRequestDto } from "../jobDecisions/dto";
import { decisionErrorResponse } from "../jobDecisions/http";
import { parseRequestBody } from "../jobDecisions/request";
import { ASK_FOR_DECISION_ROLES } from "../jobDecisions/roles";
import { requestDecision } from "../jobDecisions/service";
import { peopleByIds } from "../jobDecisions/store";
import { checkRateLimit } from "../rateLimit";

const ASK_RATE_LIMIT = { limit: 30, windowMs: 60_000 };

export async function requestJobDecision(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roleCheck = await requireRole(request, ASK_FOR_DECISION_ROLES);
  if (roleCheck) return roleCheck;

  // Counted by the verified person before anything else is done for them: an
  // over-limit caller costs no database connection.
  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const limit = checkRateLimit(`requestJobDecision:${identity.oid}`, ASK_RATE_LIMIT);
  if (!limit.allowed) {
    return { headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) }, jsonBody: { error: "Rate limit exceeded" }, status: 429 };
  }

  let connection;
  let caller: Caller | null = null;
  try {
    const parsed = parseRequestBody(await readBody(request));

    connection = await createRequestConnection(token);
    caller = await resolveCaller(request, connection);
    if (!caller) return unauthorizedResponse();

    const outcome = await requestDecision(connection, { actor: caller.actor }, parsed);
    const people = await peopleByIds(connection, outcome.request.decisionMakers.userIds);
    return {
      jsonBody: {
        callThem: outcome.schedule.callThem,
        chase: toChaseDto(outcome.chase, outcome.users, new Date()),
        request: toRequestDto(outcome.request, people),
      },
      status: 201,
    };
  } catch (error: unknown) {
    return decisionErrorResponse(error, context, "requestJobDecision", caller ?? undefined, connection);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("requestJobDecision", { methods: ["POST"], authLevel: "anonymous", handler: requestJobDecision });
