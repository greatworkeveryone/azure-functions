// Answering a decision request (jobs plan A2). One transaction, and everything an
// answer does is in it:
//
//   the decision      a dbo.JobDecisions row, and the request marked answered
//   the chase on it   the request's escalation ends (resolveWithin, its code the
//                     outcome), so the people asked stop being chased
//   the next step     the job goes to the step's owner (a person, or a role by its
//                     label) with a line in its history, and a job.next_step
//                     escalation is raised for them, due when the request's tier
//                     says (followUp.ts). A step still open from an earlier decision
//                     is closed as replaced, and its chase ends, first
//   the ledger        decision.approve | deny | defer | revise, the rationale as the
//                     reason and the decision as `after`, beside the escalation
//                     rows, all under one correlation id
//
// A failure anywhere rolls all of it back: no decision, no ledger row, nobody moved,
// nobody emailed. After the commit the owner of the next step is emailed through the
// engine's notifier (which honours DEV_EMAIL_OVERRIDE); a failed send is recorded on
// the escalation for the sweep to retry, and never undoes the answer. The person who
// asked is told in the app only: the request's escalation ends as resolved, with the
// outcome as its code and the rationale as its note, which is their "outcome of what
// I asked" in the inbox.
//
// Who may answer is checked here, against the request (standing.ts), because it needs
// the row; the endpoint has only checked the role gate. A refusal is a 403, written to
// the ledger as `denied` once the transaction has rolled back.

import type { Connection } from "tedious";
import { beginTransaction, commitTransaction, rollbackTransaction } from "../db";
import { jobLabel } from "../escalation/adapters/job";
import { holidaysFromEnv, type Holidays } from "../escalation/businessTime";
import { DECISION_PENDING_POLICY, NEXT_STEP_POLICY } from "../escalation/decisionRows";
import { raiseWithin, resolveWithin } from "../escalation/engine";
import { isUniqueViolation } from "../escalation/errors";
import type { NotifyOptions } from "../escalation/notifier";
import { getPolicy } from "../escalation/policies";
import { findLiveEscalation, listActiveUsers } from "../escalation/store";
import type { DirectoryUser, EscalationRow } from "../escalation/types";
import { newCorrelationId, record } from "../ledger";
import { recordRefusal } from "../ledger/refusals";
import {
  activeUserIdByOid,
  closeNextStep,
  decisionForRequest,
  getDecisionRow,
  insertDecision,
  insertJobEvent,
  jobParties,
  markRequestAnswered,
  openNextSteps,
  reassignJob,
  type DecisionRow,
  type JobParties,
} from "./decisionsStore";
import { followUpSchedule } from "./followUp";
import { resolveNextStepOwner, type ResolvedOwner } from "./owner";
import { RequestError } from "./request";
import { validateDeferUntil, type ParsedResponse } from "./respond";
import { decisionEventText, decisionSnapshot, darwinDay } from "./snapshots";
import { responderStanding } from "./standing";
import { getRequestRow, lockJob, type DecisionRequestRow } from "./store";
import { requestSnapshot, type UserActor } from "./service";

export interface RespondContext {
  actor: UserActor;
  holidays?: Holidays;
  /** Options for the email, as the other HTTP handlers pass (one try). */
  notify?: NotifyOptions;
  now?: Date;
  /** The caller's roles now: what makes someone a decision-maker of a role-wide request. */
  roles: readonly string[];
}

export interface AnsweredOutcome {
  /** The next step's escalation after its email went out; null when there is none to chase. */
  chase: EscalationRow | null;
  decision: DecisionRow;
  /** Who has the job now. */
  job: { assignedTo: string | null; assignedToUserId: number | null; jobId: number };
  /** The open steps of earlier decisions that this one took over from. */
  replaced: DecisionRow[];
  /** The request, answered. */
  request: DecisionRequestRow;
  /** Everyone active in AppUsers at the time, for naming people in the response. */
  users: DirectoryUser[];
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

async function rollback(connection: Connection): Promise<void> {
  await rollbackTransaction(connection).catch(() => undefined);
}

/** The active user who raised the job, when they can still be found. A job made
 *  before CreatedById existed is matched by name, but only to exactly one person. */
export async function findCreator(connection: Connection, parties: JobParties, users: readonly DirectoryUser[]): Promise<DirectoryUser | null> {
  if (parties.createdById) {
    const userId = await activeUserIdByOid(connection, parties.createdById);
    return users.find((user) => user.userId === userId) ?? null;
  }
  const name = parties.createdBy?.trim().toLowerCase();
  if (!name) return null;
  const matches = users.filter((user) => user.name.trim().toLowerCase() === name);
  return matches.length === 1 ? matches[0] : null;
}

const namesAsked = (request: DecisionRequestRow, users: readonly DirectoryUser[]): string[] =>
  request.decisionMakers.userIds.map((id) => users.find((user) => user.userId === id)?.name).filter((name): name is string => Boolean(name));

/** Closes the steps earlier decisions handed on (a later decision takes over from
 *  them) and ends the chase on them, writing a ledger row for each. */
async function replaceOpenSteps(
  connection: Connection,
  input: { actor: UserActor; buildingId: number | null; correlationId: string; jobId: number; newDecision: DecisionRow; now: Date },
): Promise<DecisionRow[]> {
  const { actor, correlationId, jobId, newDecision, now } = input;
  const older = (await openNextSteps(connection, jobId)).filter((decision) => decision.decisionId !== newDecision.decisionId);
  const note = `Replaced by the decision of ${darwinDay(newDecision.respondedAt)}`;
  const replaced: DecisionRow[] = [];
  for (const decision of older) {
    if (!(await closeNextStep(connection, decision.decisionId, { at: now, byId: actor.userId, byName: actor.name, kind: "replaced", note }))) continue;
    await record(connection, {
      action: "decision.next_step_replaced",
      actor,
      after: { closedKind: "replaced", decisionId: decision.decisionId, note, replacedBy: newDecision.decisionId },
      before: decisionSnapshot(decision),
      buildingId: input.buildingId,
      correlationId,
      jobId,
      reason: note,
      subject: { id: jobId, type: "job" },
    });
    replaced.push(decision);
  }
  // One next step is chased per job, so whichever is live is the one being replaced.
  const live = await findLiveEscalation(connection, "job", String(jobId), NEXT_STEP_POLICY);
  if (live) {
    await resolveWithin(connection, { actor, correlationId, escalationId: live.escalationId, note, now, resolutionCode: "replaced" });
  }
  return replaced;
}

/**
 * Answers a pending decision request. Throws RequestError (and EscalationError and
 * LedgerValidationError) for anything the person can act on; anything else is a
 * failure and the transaction has been rolled back.
 */
export async function respondDecision(connection: Connection, context: RespondContext, input: ParsedResponse): Promise<AnsweredOutcome> {
  const now = context.now ?? new Date();
  const holidays = context.holidays ?? holidaysFromEnv();
  const { actor } = context;
  // The date is checked before anything is touched.
  if (input.deferUntil !== null) validateDeferUntil(input.deferUntil, now, holidays);

  // The job is locked before the request, in the order asking takes them: read the
  // request to learn its job, then lock the job, then lock and re-read the request.
  const seen = await getRequestRow(connection, input.requestId);
  if (!seen) throw new RequestError("not_found", "That request doesn't exist.", 404);

  await beginTransaction(connection);
  let announce: (() => Promise<EscalationRow>) | null = null;
  let outcome: Omit<AnsweredOutcome, "chase" | "request" | "users">;
  let users: DirectoryUser[];
  try {
    const job = await lockJob(connection, seen.jobId);
    if (!job) throw new RequestError("job_not_found", "That job doesn't exist.", 404);
    const request = await getRequestRow(connection, input.requestId, { forUpdate: true });
    if (!request) throw new RequestError("not_found", "That request doesn't exist.", 404);

    users = await listActiveUsers(connection);
    const standing = responderStanding(request, { roles: context.roles, userId: actor.userId }, namesAsked(request, users));
    if (!standing.allowed) throw new RequestError("not_a_decision_maker", standing.message, 403, { reason: standing.code });

    if (request.state !== "pending") {
      const answered = request.state === "answered" ? await decisionForRequest(connection, request.requestId) : null;
      throw new RequestError("not_pending", `This question was already ${request.state === "answered" ? "answered" : "withdrawn"}.`, 409, {
        request,
        ...(answered ? { decision: answered } : {}),
      });
    }
    if (request.rowVersion !== input.rowVersion) {
      throw new RequestError("stale", "Someone else changed this request. Reload it to see their change.", 409, { request });
    }
    if (job.isArchived || job.status === "Done") {
      throw new RequestError("job_closed", "That job is closed, so the question can't be answered. Reopen the job, or take the question back.", 409, { request });
    }

    // Who has the next step, and when it is due.
    const parties = (await jobParties(connection, job.jobId)) ?? { assignedTo: null, assignedToUserId: null, createdBy: null, createdById: null };
    let owner: ResolvedOwner | null = null;
    let schedule: ReturnType<typeof followUpSchedule> | null = null;
    // Chasing the step is the policy's to switch off; the answer is not held up by it.
    let chased = false;
    if (input.nextStep !== null) {
      const creator = input.nextStepOwner === null ? await findCreator(connection, parties, users) : null;
      owner = resolveNextStepOwner(input.nextStepOwner, users, creator);
      schedule = followUpSchedule(request, "next_step", now, holidays);
      const policy = await getPolicy(connection, NEXT_STEP_POLICY, now.getTime());
      chased = policy === null || policy.active;
    }

    const correlationId = newCorrelationId();
    const decisionId = await insertDecision(connection, {
      deferUntil: input.deferUntil,
      jobId: job.jobId,
      nextStep: input.nextStep,
      nextStepDueAt: schedule ? schedule.respondBy : null,
      nextStepOwnerRole: owner?.role ?? null,
      nextStepOwnerUserId: owner?.userId ?? null,
      outcome: input.outcome,
      rationale: input.rationale,
      requestId: request.requestId,
      respondedAt: now,
      respondedById: actor.userId,
      respondedByName: actor.name,
    });
    if (!(await markRequestAnswered(connection, request.requestId, request.rowVersion))) {
      throw new RequestError("stale", "Someone else changed this request. Reload it to see their change.", 409, { request });
    }
    const decision = await getDecisionRow(connection, decisionId);
    if (!decision) throw new Error(`decision ${decisionId} vanished inside its own transaction`);

    await record(connection, {
      action: `decision.${input.outcome}` as const,
      actor,
      after: decisionSnapshot(decision, {
        answeredAs: standing.via,
        nextStepChased: owner ? chased : null,
        nextStepOwner: owner ? { kind: owner.kind, name: owner.name } : null,
      }),
      before: requestSnapshot(request),
      buildingId: job.buildingId,
      correlationId,
      jobId: job.jobId,
      reason: input.rationale,
      ruleApplied: `responder.${standing.via}`,
      subject: { id: job.jobId, type: "job" },
    });

    // The people who were asked stop being chased: the question has its answer.
    const chase = await findLiveEscalation(connection, "job", String(job.jobId), DECISION_PENDING_POLICY);
    if (chase) {
      await resolveWithin(connection, { actor, correlationId, escalationId: chase.escalationId, note: input.rationale, now, resolutionCode: input.outcome });
    }

    // The job goes to whoever does what comes next; a step an earlier decision handed on is over.
    let replaced: DecisionRow[] = [];
    let assignedTo = parties.assignedTo;
    let assignedToUserId = parties.assignedToUserId;
    if (owner && schedule) {
      replaced = await replaceOpenSteps(connection, { actor, buildingId: job.buildingId, correlationId, jobId: job.jobId, newDecision: decision, now });
      if (owner.name !== parties.assignedTo || owner.userId !== parties.assignedToUserId) {
        await reassignJob(connection, job.jobId, { name: owner.name, userId: owner.userId });
        await insertJobEvent(connection, {
          createdBy: actor.name,
          eventType: "assignment_change",
          jobId: job.jobId,
          newAssignee: owner.name,
          text: `Reassigned to ${owner.name} (was ${parties.assignedTo || "—"})`,
        });
        assignedTo = owner.name;
        assignedToUserId = owner.userId;
      }
    }
    await insertJobEvent(connection, { createdBy: actor.name, eventType: "decision", jobId: job.jobId, text: decisionEventText(decision, owner?.name ?? null) });

    // And what comes next is chased: the owner, then their manager, then a director.
    if (owner && schedule && input.nextStep !== null) {
      if (chased) {
        const label = jobLabel({ buildingName: job.buildingName, jobId: job.jobId, title: job.title });
        const raised = await raiseWithin(connection, {
          actor,
          context: {
            nextStep: {
              decisionId,
              dueAt: schedule.respondBy ? schedule.respondBy.toISOString() : null,
              jobLabel: label,
              nextStep: input.nextStep,
              outcome: input.outcome,
              ownerRole: owner.role,
              ownerUserId: owner.userId,
              rationale: input.rationale,
              requestId: request.requestId,
              respondedBy: actor.name,
            },
            schedule: {
              escalateAt: schedule.escalateAt ? schedule.escalateAt.toISOString() : null,
              remindAt: schedule.remindAt.map((at) => at.toISOString()),
            },
          },
          correlationId,
          dueAt: schedule.escalateAt ?? schedule.respondBy,
          headline: `Next step: ${clip(oneLine(input.nextStep), 200)}`,
          ladderRaiser: owner.ladder,
          note: input.nextStep,
          notify: context.notify ?? { attempts: 1 },
          now,
          policyKey: NEXT_STEP_POLICY,
          subjectId: String(job.jobId),
          subjectType: "job",
          urgent: schedule.urgent,
          userTargets: owner.members.map((member) => member.userId),
        });
        // A next step already chased on this job was ended above; something else raised one.
        if (!raised.created) {
          throw new RequestError("stale", "Something else changed this job while you were answering. Reload it and try again.", 409, { request });
        }
        announce = raised.announce;
      }
    }

    outcome = { decision, job: { assignedTo, assignedToUserId, jobId: job.jobId }, replaced };
    await commitTransaction(connection);
  } catch (error) {
    await rollback(connection);
    // A request is answered once (the unique index on JobDecisions.RequestId): two
    // answers at the same moment cannot both get in.
    if (isUniqueViolation(error) && /UX_JobDecisions_Request/.test((error as Error).message ?? "")) {
      const current = await getRequestRow(connection, input.requestId);
      throw new RequestError("not_pending", "This question was just answered by someone else.", 409, current ? { request: current } : {});
    }
    if (error instanceof RequestError && error.code === "not_a_decision_maker") {
      await recordRefusal(
        connection,
        actor,
        { id: seen.jobId, type: "job" },
        {
          attempted: `decision.${input.outcome}` as const,
          code: "not_a_decision_maker",
          message: error.message,
          state: { assignmentMode: seen.assignmentMode, requestId: seen.requestId, state: seen.state, tier: seen.tier },
        },
        seen.jobId,
      );
    }
    throw error;
  }

  // Committed. The email never undoes it.
  const chase = announce ? await (announce as () => Promise<EscalationRow>)() : null;
  const request = await getRequestRow(connection, input.requestId);
  if (!request) throw new Error(`decision request ${input.requestId} is not there after its commit`);
  return { ...outcome, chase, request, users };
}
