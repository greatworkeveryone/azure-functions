// Asking for a decision on an Admin / Accounts job, and taking the question back
// (jobs plan A1). The decision request is one row; the escalation engine does the
// chasing; the ledger remembers both. Each operation is ONE transaction:
//
//   ask       the request row, the escalation (its row, its ledger row, the job's
//             flag) and the decision.requested ledger row. A failure anywhere
//             rolls all of it back: no ledger row, no request, nothing to chase.
//             After the commit the people asked are emailed through the engine's
//             notifier (which honours DEV_EMAIL_OVERRIDE); a failed send is
//             recorded on the escalation for the sweep to retry, and never undoes
//             the request.
//   withdraw  the request's state, the escalation ending, and decision.withdrawn,
//             with the reason, together.
//
// Who may ask or withdraw is the endpoint's to have checked, except that only the
// person who asked (or an admin) may take a question back, which needs the row and
// so is checked here.

import type { Connection } from "tedious";
import { AppRole } from "../auth";
import { beginTransaction, commitTransaction, rollbackTransaction } from "../db";
import { jobLabel } from "../escalation/adapters/job";
import { holidaysFromEnv, type Holidays } from "../escalation/businessTime";
import { DECISION_PENDING_POLICY } from "../escalation/decisionRows";
import { raiseWithin, withdrawWithin } from "../escalation/engine";
import { isUniqueViolation } from "../escalation/errors";
import type { NotifyOptions } from "../escalation/notifier";
import { findLiveEscalation, listActiveUsers } from "../escalation/store";
import type { DirectoryUser, EscalationRow } from "../escalation/types";
import { ADMIN_KIND } from "../jobKinds";
import { newCorrelationId, record, type LedgerActor } from "../ledger";
import { resolveDecisionMakers } from "./people";
import { RequestError, type ParsedRequest } from "./request";
import {
  attachmentOnJob,
  findPending,
  getRequestRow,
  insertRequest,
  jobBuilding,
  lockJob,
  markWithdrawn,
  type DecisionRequestRow,
} from "./store";
import { scheduleFor, type TierSchedule } from "./tiers";

export type UserActor = Extract<LedgerActor, { kind: "user" }>;

export interface RequestContext {
  actor: UserActor;
  holidays?: Holidays;
  /** Options for the emails, as the other HTTP handlers pass (one try). */
  notify?: NotifyOptions;
  now?: Date;
}

export interface AskedOutcome {
  /** The live escalation after the emails went out. */
  chase: EscalationRow;
  request: DecisionRequestRow;
  schedule: TierSchedule;
  /** Everyone active in AppUsers at the time, for naming people in the response. */
  users: DirectoryUser[];
}

const isoOrNull = (date: Date | null): string | null => (date ? date.toISOString() : null);

/** The request as the ledger keeps it. */
export function requestSnapshot(request: DecisionRequestRow, schedule?: TierSchedule): Record<string, unknown> {
  return {
    assignmentMode: request.assignmentMode,
    autoEscalate: request.autoEscalate,
    callThem: request.tier === "emergency",
    decisionMakers: request.decisionMakers,
    jobId: request.jobId,
    question: request.question,
    requestId: request.requestId,
    respondBy: isoOrNull(request.respondBy),
    routineWeeks: request.routineWeeks,
    sourceAttachmentId: request.sourceAttachmentId,
    state: request.state,
    tier: request.tier,
    ...(schedule ? { escalateAt: isoOrNull(schedule.escalateAt), remindAt: schedule.remindAt.map((at) => at.toISOString()) } : {}),
    ...(request.withdrawnAt
      ? { withdrawn: { at: request.withdrawnAt.toISOString(), by: request.withdrawnBy, reason: request.withdrawnReason } }
      : {}),
  };
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** A second ask while one is open: the SQL error of either unique index. */
function alreadyPending(request: DecisionRequestRow | null): RequestError {
  return new RequestError(
    "already_pending",
    "This job already has a question waiting for a decision. Withdraw it first, or wait for the answer.",
    409,
    request ? { request } : {},
  );
}

async function rollback(connection: Connection): Promise<void> {
  await rollbackTransaction(connection).catch(() => undefined);
}

/**
 * Asks for a decision. Throws RequestError (and TierError, EscalationError and
 * LedgerValidationError) for anything the person can act on; anything else is a
 * failure and the transaction has been rolled back.
 */
export async function requestDecision(connection: Connection, context: RequestContext, parsed: ParsedRequest): Promise<AskedOutcome> {
  const now = context.now ?? new Date();
  const { actor } = context;
  // The tier is checked before anything is touched.
  const schedule = scheduleFor(parsed.tier, now, context.holidays ?? holidaysFromEnv());

  await beginTransaction(connection);
  let announce: () => Promise<EscalationRow>;
  let requestId: number;
  let users: DirectoryUser[];
  try {
    const job = await lockJob(connection, parsed.jobId);
    if (!job) throw new RequestError("job_not_found", "That job doesn't exist.", 404);
    if (job.kind !== ADMIN_KIND) {
      throw new RequestError("not_an_admin_job", "Only an Admin / Accounts job can ask for a decision.", 422, { kind: job.kind });
    }
    if (job.isArchived || job.status === "Done") {
      throw new RequestError("job_closed", "That job is closed, so it can't ask for a decision. Reopen it first.", 409);
    }
    const pending = await findPending(connection, job.jobId);
    if (pending) throw alreadyPending(pending);

    if (parsed.sourceAttachmentId !== null && !(await attachmentOnJob(connection, parsed.sourceAttachmentId, job.jobId))) {
      throw new RequestError("attachment_not_on_job", "That file isn't attached to this job, so the decision can't be about it.", 422, {
        sourceAttachmentId: parsed.sourceAttachmentId,
      });
    }

    users = await listActiveUsers(connection);
    const makers = resolveDecisionMakers(parsed.makers, users, actor.userId);
    const correlationId = newCorrelationId();

    requestId = await insertRequest(connection, {
      assignmentMode: parsed.makers.mode,
      autoEscalate: schedule.autoEscalate,
      decisionMakers: { role: makers.role, userIds: makers.userIds },
      jobId: job.jobId,
      question: parsed.question,
      requestedBy: actor.name,
      requestedByUserId: actor.userId,
      respondBy: schedule.respondBy,
      routineWeeks: schedule.routineWeeks,
      sourceAttachmentId: parsed.sourceAttachmentId,
      tier: schedule.tier,
    });

    const label = jobLabel({ buildingName: job.buildingName, jobId: job.jobId, title: job.title });
    const raised = await raiseWithin(connection, {
      actor,
      context: {
        decision: {
          assignmentMode: parsed.makers.mode,
          autoEscalate: schedule.autoEscalate,
          callThem: schedule.callThem,
          jobLabel: label,
          question: parsed.question,
          requestId,
          respondBy: isoOrNull(schedule.respondBy),
          tier: schedule.tier,
        },
        schedule: { escalateAt: isoOrNull(schedule.escalateAt), remindAt: schedule.remindAt.map((at) => at.toISOString()) },
      },
      correlationId,
      dueAt: schedule.escalateAt,
      headline: `Decision needed: ${oneLine(parsed.question)}`,
      note: parsed.question,
      notify: context.notify ?? { attempts: 1 },
      now,
      policyKey: DECISION_PENDING_POLICY,
      reason: "needs_decision",
      subjectId: String(job.jobId),
      subjectType: "job",
      urgent: schedule.urgent,
      userTargets: makers.userIds,
    });
    // A live escalation with no pending request behind it: something else raised it.
    if (!raised.created) throw alreadyPending(null);
    announce = raised.announce;

    const request = await getRequestRow(connection, requestId);
    if (!request) throw new Error(`decision request ${requestId} vanished inside its own transaction`);
    await record(connection, {
      action: "decision.requested",
      actor,
      after: requestSnapshot(request, schedule),
      buildingId: job.buildingId,
      correlationId,
      jobId: job.jobId,
      ruleApplied: `decision_request.${schedule.tier}`,
      subject: { id: job.jobId, type: "job" },
    });
    await commitTransaction(connection);
  } catch (error) {
    await rollback(connection);
    if (isUniqueViolation(error)) throw alreadyPending(await findPending(connection, parsed.jobId));
    throw error;
  }

  // Committed. The emails never undo it.
  const chase = await announce();
  const request = await getRequestRow(connection, requestId);
  if (!request) throw new Error(`decision request ${requestId} is not there after its commit`);
  return { chase, request, schedule, users };
}

export interface WithdrawInput {
  /** Base64, from the request as the screen last read it: a stale one is a 409. */
  expectedRowVersion?: string | null;
  reason: string;
  requestId: number;
}

/** Takes a pending request back. Throws RequestError for what the person can act on. */
export async function withdrawDecision(
  connection: Connection,
  context: Pick<RequestContext, "actor" | "now"> & { roles: readonly string[] },
  input: WithdrawInput,
): Promise<DecisionRequestRow> {
  const now = context.now ?? new Date();
  const { actor } = context;

  await beginTransaction(connection);
  try {
    const row = await getRequestRow(connection, input.requestId, { forUpdate: true });
    if (!row) throw new RequestError("not_found", "That request doesn't exist.", 404);

    const isAsker = actor.userId !== null && row.requestedByUserId === actor.userId;
    if (!isAsker && !context.roles.includes(AppRole.ADMIN)) {
      throw new RequestError("forbidden", "Only the person who asked can take the question back.", 403);
    }
    if (row.state !== "pending") {
      throw new RequestError("not_pending", `This question was already ${row.state === "answered" ? "answered" : "withdrawn"}.`, 409, { request: row });
    }
    if (input.expectedRowVersion && row.rowVersion !== input.expectedRowVersion) {
      throw new RequestError("stale", "Someone else changed this request. Reload it to see their change.", 409, { request: row });
    }

    const correlationId = newCorrelationId();
    // Whichever level it has reached, the chase ends with the question.
    const live = await findLiveEscalation(connection, "job", String(row.jobId), DECISION_PENDING_POLICY);
    if (live) {
      await withdrawWithin(connection, { actor, correlationId, escalationId: live.escalationId, now, reason: input.reason });
    }

    const done = await markWithdrawn(connection, row.requestId, { at: now, by: actor.name, byUserId: actor.userId, reason: input.reason });
    if (!done) throw new RequestError("stale", "Someone else changed this request. Reload it to see their change.", 409);
    const withdrawn = await getRequestRow(connection, row.requestId);
    if (!withdrawn) throw new Error(`decision request ${row.requestId} vanished inside its own transaction`);

    const job = await jobBuilding(connection, row.jobId);
    await record(connection, {
      action: "decision.withdrawn",
      actor,
      after: requestSnapshot(withdrawn),
      before: requestSnapshot(row),
      buildingId: job?.buildingId ?? null,
      correlationId,
      jobId: row.jobId,
      reason: input.reason,
      subject: { id: row.jobId, type: "job" },
    });
    await commitTransaction(connection);
    return withdrawn;
  } catch (error) {
    await rollback(connection);
    throw error;
  }
}
