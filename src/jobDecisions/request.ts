// Reading a decision request's input, and the one error type the decision
// request code throws for anything the person asking (or answering, or finishing a
// next step: jobs plan A2) can act on (jobs plan A1).
// Pure: no I/O. The endpoints turn a RequestError, and the TierError of tiers.ts,
// into the response.
//
// POST /api/requestJobDecision body:
//
//   jobId               the Admin / Accounts job the question is about
//   question            what is being asked, 1 to 2000 characters
//   assignmentMode      "named"  (these people) or "role" (everyone in a role)
//   decisionMakers      { userIds: [3, 5] }  for named, 1 to 25 AppUsers ids
//                       { role: "accounts_manager" }  for role
//   tier                emergency | urgent | soon | routine | fixed
//   autoEscalate        optional true | false. Urgent only: true moves it up to the
//                       raiser's manager at the 36-hour mark if still unanswered;
//                       absent or false (the default) never moves it up, and the
//                       reminder at 24 hours goes either way. Soon, routine and fixed
//                       always move up, so false is refused (400); an emergency
//                       ignores it.
//   routineWeeks        2 to 8, routine only
//   fixedDate           YYYY-MM-DD, a working day in Darwin, fixed only
//   sourceAttachmentId  optional: the file on this job the decision is about

import { normaliseRole, ROLES } from "../escalation/roles";
import { parseTierRequest, type TierRequest } from "./tiers";
import { ADMIN_DOES_NOT_DECIDE, DECISION_MAKER_ROLES } from "./roles";

export const QUESTION_MAX_CHARS = 2000;
export const WITHDRAW_REASON_MAX_CHARS = 1000;
export const MAX_DECISION_MAKERS = 25;

export type RequestErrorCode =
  | "already_done"
  | "already_pending"
  | "attachment_not_on_job"
  | "bad_request"
  | "decision_maker_is_requester"
  | "decision_maker_role_not_allowed"
  | "decision_maker_unknown"
  | "defer_until_invalid"
  | "defer_until_not_a_working_day"
  | "defer_until_past"
  | "defer_until_required"
  | "defer_until_too_far"
  | "forbidden"
  | "job_closed"
  | "job_not_found"
  | "next_step_owner_required"
  | "next_step_owner_role_empty"
  | "next_step_owner_role_not_allowed"
  | "next_step_owner_unknown"
  | "next_step_required"
  | "no_next_step"
  | "not_a_decision_maker"
  | "not_an_admin_job"
  | "not_found"
  | "not_next_step_owner"
  | "not_pending"
  | "outcome_invalid"
  | "rationale_required"
  | "reason_required"
  | "role_has_no_one"
  | "stale"
  | "step_replaced"
  | "unexpected_defer_until";

/** What the person asking got wrong, or got too late. `details` is merged into the
 *  response body (the request that is already pending, say). */
export class RequestError extends Error {
  readonly code: RequestErrorCode;
  readonly details: Record<string, unknown>;
  readonly status: number;

  constructor(code: RequestErrorCode, message: string, status: number, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "RequestError";
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

export type DecisionMakersInput = { mode: "named"; userIds: number[] } | { mode: "role"; role: string };

export interface ParsedRequest {
  jobId: number;
  makers: DecisionMakersInput;
  question: string;
  sourceAttachmentId: number | null;
  tier: TierRequest;
}

const bad = (message: string): RequestError => new RequestError("bad_request", message, 400);

/** A positive whole number written as a JSON number or as digits. */
export function readId(value: unknown, field: string): number {
  const id = typeof value === "string" && /^\d{1,10}$/.test(value) ? Number(value) : value;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647) {
    throw bad(`${field} must be a whole number`);
  }
  return id;
}

function readQuestion(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw bad("Say what you are asking (question is required)");
  const question = value.trim();
  if (question.length > QUESTION_MAX_CHARS) throw bad(`The question can be at most ${QUESTION_MAX_CHARS} characters`);
  return question;
}

const isBlank = (value: unknown): boolean => value === undefined || value === null || value === "";

function readDecisionMakers(mode: unknown, value: unknown): DecisionMakersInput {
  if (mode !== "named" && mode !== "role") throw bad('assignmentMode must be "named" or "role"');
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw bad("decisionMakers must be an object");
  const makers = value as Record<string, unknown>;

  if (mode === "named") {
    if (!isBlank(makers.role)) throw bad("Name the people with userIds; role only goes with assignmentMode role");
    const list = makers.userIds;
    if (!Array.isArray(list) || list.length === 0) throw bad("decisionMakers.userIds must list at least one person");
    if (list.length > MAX_DECISION_MAKERS) throw bad(`Ask at most ${MAX_DECISION_MAKERS} people, or ask a whole role`);
    const userIds = list.map((id) => readId(id, "decisionMakers.userIds"));
    if (new Set(userIds).size !== userIds.length) throw bad("decisionMakers.userIds names someone twice");
    return { mode, userIds };
  }

  if (!(makers.userIds === undefined || makers.userIds === null || (Array.isArray(makers.userIds) && makers.userIds.length === 0))) {
    throw bad("Ask a role with decisionMakers.role; userIds only goes with assignmentMode named");
  }
  if (typeof makers.role !== "string" || normaliseRole(makers.role) === "") throw bad("decisionMakers.role must name a role");
  const role = normaliseRole(makers.role);
  if (role === ROLES.admin) {
    throw new RequestError(
      "decision_maker_role_not_allowed",
      `${ADMIN_DOES_NOT_DECIDE}, so a question can't be put to the Admin role. Ask a director, the CFO or a manager.`,
      422,
      { role },
    );
  }
  if (!DECISION_MAKER_ROLES.includes(role)) {
    throw bad(`decisionMakers.role must be one of ${DECISION_MAKER_ROLES.join(", ")}`);
  }
  return { mode, role };
}

/** A request body -> the typed request, or a RequestError / TierError. */
export function parseRequestBody(body: Record<string, unknown>): ParsedRequest {
  return {
    jobId: readId(body.jobId, "jobId"),
    makers: readDecisionMakers(body.assignmentMode, body.decisionMakers),
    question: readQuestion(body.question),
    sourceAttachmentId: isBlank(body.sourceAttachmentId) ? null : readId(body.sourceAttachmentId, "sourceAttachmentId"),
    tier: parseTierRequest(body),
  };
}

/** The reason for taking a request back: required, at most 1000 characters. */
export function readWithdrawReason(value: unknown): string {
  if (value !== undefined && value !== null && typeof value !== "string") throw bad("reason must be text");
  const reason = typeof value === "string" ? value.trim() : "";
  if (reason === "") throw new RequestError("reason_required", "Say why you are taking the question back", 400);
  if (reason.length > WITHDRAW_REASON_MAX_CHARS) throw bad(`The reason can be at most ${WITHDRAW_REASON_MAX_CHARS} characters`);
  return reason;
}
