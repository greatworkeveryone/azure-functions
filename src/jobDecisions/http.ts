// What the decision request endpoints share: turning what the request code throws
// into a response (jobs plan A1, and the endpoints that answer and finish A2). A
// RequestError or a TierError is the person's to fix and says so with a stable
// `code`; an engine error is the escalation engine's own (escalation/http); anything
// else is a failure that goes to Sentry.

import type { HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { escalationErrorResponse, type Caller } from "../escalation/http";
import type { DecisionRow } from "./decisionsStore";
import { toDecisionDto, toRequestDto, type PeopleById } from "./dto";
import { RequestError } from "./request";
import { peopleByIds, type DecisionRequestRow } from "./store";
import { TierError } from "./tiers";

const isRequestRow = (value: unknown): value is DecisionRequestRow =>
  value !== null && typeof value === "object" && typeof (value as { requestId?: unknown }).requestId === "number" && "decisionMakers" in (value as object);

const isDecisionRow = (value: unknown): value is DecisionRow =>
  value !== null && typeof value === "object" && typeof (value as { decisionId?: unknown }).decisionId === "number";

/** The people a response names, by id; none if they cannot be read (the response
 *  still goes, with their names missing). */
export async function peopleFor(connection: Connection | undefined, userIds: readonly (number | null)[]): Promise<PeopleById> {
  if (!connection) return new Map();
  try {
    return await peopleByIds(connection, userIds.filter((id): id is number => id !== null));
  } catch {
    return new Map();
  }
}

/** The people a decision names: who answered it and who has its next step. */
export const decisionPeople = (decision: DecisionRow): (number | null)[] => [decision.respondedById, decision.nextStepOwnerUserId];

/**
 * The response for an error thrown while asking, reading or withdrawing. A
 * RequestError carrying the request it is about (already pending, stale) sends it
 * back as a request DTO so the screen can show what is there now.
 */
export async function decisionErrorResponse(
  error: unknown,
  context: InvocationContext,
  name: string,
  caller?: Caller,
  connection?: Connection,
): Promise<HttpResponseInit> {
  if (error instanceof TierError) {
    return { jsonBody: { code: error.code, error: error.message }, status: error.status };
  }
  if (error instanceof RequestError) {
    const { decision, request, ...details } = error.details;
    const current = isRequestRow(request) ? toRequestDto(request, await peopleFor(connection, request.decisionMakers.userIds)) : undefined;
    const answered = isDecisionRow(decision) ? toDecisionDto(decision, await peopleFor(connection, decisionPeople(decision)), null, new Date()) : undefined;
    return {
      jsonBody: { code: error.code, error: error.message, ...details, ...(current ? { request: current } : {}), ...(answered ? { decision: answered } : {}) },
      status: error.status,
    };
  }
  return escalationErrorResponse(error, context, name, caller);
}
