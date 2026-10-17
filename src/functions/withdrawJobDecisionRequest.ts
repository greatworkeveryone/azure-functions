// POST /api/withdrawJobDecisionRequest   (jobs plan A1)
//
// Body { requestId, reason, rowVersion? }
//
// The person who asked takes a pending question back (an admin can too). `reason`
// is required, at most 1000 characters; it goes in the decision ledger
// (decision.withdrawn, an exception) and on the request. In ONE transaction the
// request ends as withdrawn, the escalation chasing it ends (whichever level it has
// reached) and both ledger rows are written. The people asked are not emailed:
// nobody needs to do anything. `rowVersion`, when sent, is the request's version as
// the screen read it, and a stale one is a 409.
//
// 200 { request: RequestDto }
// 400 no reason; 403 not the person who asked (or an admin)
// 404 no such request
// 409 not_pending (already answered or withdrawn; carries the request) or stale
//
// Gate: whoever may edit jobs (ASK_FOR_DECISION_ROLES), then asker-or-admin on the row.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { closeConnection, createRequestConnection } from "../db";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import "../escalation/adapters";
import { readBody, readOptionalText, resolveCaller, type Caller } from "../escalation/http";
import { toRequestDto } from "../jobDecisions/dto";
import { decisionErrorResponse } from "../jobDecisions/http";
import { readId, readWithdrawReason } from "../jobDecisions/request";
import { ASK_FOR_DECISION_ROLES } from "../jobDecisions/roles";
import { withdrawDecision } from "../jobDecisions/service";
import { peopleByIds } from "../jobDecisions/store";
import { checkRateLimit } from "../rateLimit";

const WITHDRAW_RATE_LIMIT = { limit: 30, windowMs: 60_000 };

export async function withdrawJobDecisionRequest(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roleCheck = await requireRole(request, ASK_FOR_DECISION_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  let caller: Caller | null = null;
  try {
    const body = await readBody(request);
    const requestId = readId(body.requestId, "requestId");
    const reason = readWithdrawReason(body.reason);
    const rowVersion = readOptionalText(body.rowVersion, "rowVersion", 64);

    connection = await createRequestConnection(token);
    caller = await resolveCaller(request, connection);
    if (!caller) return unauthorizedResponse();

    const limit = checkRateLimit(`withdrawJobDecisionRequest:${caller.actor.userId ?? caller.actor.name}`, WITHDRAW_RATE_LIMIT);
    if (!limit.allowed) {
      return { headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) }, jsonBody: { error: "Rate limit exceeded" }, status: 429 };
    }

    const withdrawn = await withdrawDecision(connection, { actor: caller.actor, roles: caller.viewer.roles }, { expectedRowVersion: rowVersion, reason, requestId });
    const people = await peopleByIds(connection, withdrawn.decisionMakers.userIds);
    return { jsonBody: { request: toRequestDto(withdrawn, people) }, status: 200 };
  } catch (error: unknown) {
    return decisionErrorResponse(error, context, "withdrawJobDecisionRequest", caller ?? undefined, connection);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("withdrawJobDecisionRequest", { methods: ["POST"], authLevel: "anonymous", handler: withdrawJobDecisionRequest });
