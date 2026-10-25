// POST /api/raiseEscalation   (manual escalate from the job modal and board)
//
// Body { subjectType, subjectId, reason, note, targetUserId? }
//   reason  stalled | needs_decision | over_my_authority | other   (the dialog's four choices)
//   note    required: why, in a sentence or two (at most 2000 characters)
//   targetUserId  optional: a specific person at the level it goes to (PLAN §3.7 rule 4)
//
// 201 { escalation: EscalationDto }  raised; the targets are emailed
// 409 { code: "already_open", error, escalation }  that subject already has a live manual escalation
// 404 the subject doesn't exist or the caller can't see it; 422 targetUserId isn't at that level
//
// The policy is the subject's manual one (job.manual, or any.manual), never the
// caller's choice. The target is the raiser's manager role and then the
// directors, never the raiser (ladder.ts).
//
// Gate: ESCALATION_ROLES (frontend capability raiseEscalation); at most 30 a
// minute per person.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { closeConnection, createRequestConnection } from "../db";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import { checkRateLimit } from "../rateLimit";
import "../escalation/adapters";
import { requireAdapter } from "../escalation/adapters/registry";
import { raise } from "../escalation/engine";
import { toDto } from "../escalation/dto";
import { EscalationError } from "../escalation/errors";
import { manualPolicyKey } from "../escalation/manual";
import {
  ESCALATION_ROLES,
  escalationErrorResponse,
  readBody,
  readOptionalText,
  readOptionalUserId,
  resolveCaller,
  type Caller,
} from "../escalation/http";
import { listActiveUsers } from "../escalation/store";
import { MANUAL_REASONS, NOTE_MAX_CHARS, REASON_LABELS, type DirectoryUser, type ManualReason } from "../escalation/types";

const RAISE_RATE_LIMIT = { limit: 30, windowMs: 60_000 };

export async function raiseEscalation(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roleCheck = await requireRole(request, ESCALATION_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  let caller: Caller | null = null;
  let directory: DirectoryUser[] = [];
  try {
    const body = await readBody(request);
    const subjectType = typeof body.subjectType === "string" ? body.subjectType.trim() : "";
    const subjectId = typeof body.subjectId === "number" ? String(body.subjectId) : typeof body.subjectId === "string" ? body.subjectId.trim() : "";
    if (!subjectType || subjectType.length > 32 || !subjectId || subjectId.length > 64) {
      throw new EscalationError("bad_request", "subjectType and subjectId are required");
    }
    const reason = body.reason;
    if (typeof reason !== "string" || !MANUAL_REASONS.includes(reason as ManualReason)) {
      throw new EscalationError("bad_request", `reason must be one of ${MANUAL_REASONS.join(", ")}`);
    }
    const note = readOptionalText(body.note, "note", NOTE_MAX_CHARS);
    if (!note) throw new EscalationError("bad_request", "Say why you are escalating it (note is required)");
    const preferredUserId = readOptionalUserId(body.targetUserId, "targetUserId");

    connection = await createRequestConnection(token);
    caller = await resolveCaller(request, connection);
    if (!caller) return unauthorizedResponse();

    const limit = checkRateLimit(`raiseEscalation:${caller.actor.userId ?? caller.actor.name}`, RAISE_RATE_LIMIT);
    if (!limit.allowed) {
      return { headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) }, jsonBody: { error: "Rate limit exceeded" }, status: 429 };
    }

    const adapter = requireAdapter(subjectType);
    const policyKey = await manualPolicyKey(connection, subjectType);
    if (!adapter.visibleTo(caller.viewer, { policyKey, subjectId, subjectType })) {
      throw new EscalationError("subject_not_found", "That can't be found, or you can't escalate it");
    }

    const result = await raise(connection, {
      actor: caller.actor,
      headline: `Escalated by ${caller.actor.name}: ${REASON_LABELS[reason as ManualReason]}`,
      note,
      notify: { attempts: 1 },
      policyKey,
      preferredUserId,
      reason,
      subjectId,
      subjectType,
    });

    directory = await listActiveUsers(connection);
    const escalation = toDto(result.escalation, caller.viewer, new Date(), directory);
    if (!result.created) {
      return { jsonBody: { code: "already_open", error: "This has already been escalated and is still open.", escalation }, status: 409 };
    }
    return { jsonBody: { escalation }, status: 201 };
  } catch (error: unknown) {
    return escalationErrorResponse(error, context, "raiseEscalation", caller ?? undefined, directory);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("raiseEscalation", { methods: ["POST"], authLevel: "anonymous", handler: raiseEscalation });
