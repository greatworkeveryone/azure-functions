// Marking a decision's next step done (jobs plan A2). One transaction:
//
//   the step        closed as done, by whom and when, with an optional note
//   the chase       the job.next_step escalation ends (resolveWithin), so the owner,
//                   their manager and a director stop being told
//   the ledger      decision.next_step_done, the note as the reason
//   the job         moved to Done through the in-house close path (closeJob.ts), if
//                   this was the last thing it was waiting for
//
// The job is finished only when nothing is left to do about it, and only when what
// was decided was an end: an approval or a denial. A step that was a revision goes
// back to the person who raised the job so they can ask again, and a deferral's
// question is still to come back, so finishing either leaves the job open. And it stays
// open while a question waits for an answer, another step is open, or a deferral is
// waiting for its day. The response says which of these it was, so the screen can say
// what happens next rather than leave the person wondering.
//
// Who may finish a step: the person it was handed to, anyone in the role it was handed
// to now, or a manager and above (standing.ts). Anyone else is refused (403) and the
// refusal is ledgered as `denied`, once the transaction has rolled back.

import type { Connection } from "tedious";
import { beginTransaction, commitTransaction, rollbackTransaction } from "../db";
import { NEXT_STEP_POLICY, nextStepOf } from "../escalation/decisionRows";
import { resolveWithin } from "../escalation/engine";
import { findLiveEscalation, listActiveUsers } from "../escalation/store";
import { ADMIN_KIND } from "../jobKinds";
import { newCorrelationId, record } from "../ledger";
import { recordRefusal } from "../ledger/refusals";
import { closeInternalJobWithin } from "./closeJob";
import { closeNextStep, getDecisionRow, hasScheduledReask, insertJobEvent, openNextSteps, type DecisionRow } from "./decisionsStore";
import { RequestError } from "./request";
import { decisionSnapshot } from "./snapshots";
import { stepStanding } from "./standing";
import { findPending, lockJob } from "./store";
import type { UserActor } from "./service";

export interface CompleteContext {
  actor: UserActor;
  now?: Date;
  /** The caller's roles now: whether they hold the role the step was handed to, or are a manager. */
  roles: readonly string[];
}

export interface CompleteInput {
  decisionId: number;
  note: string | null;
  /** The decision's version as the screen last read it; when sent, a stale one is a 409. */
  rowVersion: string | null;
}

/** Why the job was not finished by this step, for the screen to say. */
export type JobStaysOpen =
  /** The job was closed already. */
  | "already_closed"
  /** A question is waiting for an answer. */
  | "pending_request"
  /** Another next step is still open. */
  | "other_step"
  /** A deferred question is still to come back. */
  | "deferred"
  /** The decision was to ask for revisions: the person who raised the job asks again. */
  | "revise"
  /** The close path refused (the job's own rules), which the message says. */
  | "refused";

export interface CompletedOutcome {
  /** The decision, with its step closed. */
  decision: DecisionRow;
  /** The job was moved to Done by this. */
  jobClosed: boolean;
  jobId: number;
  jobStaysOpen: JobStaysOpen | null;
  /** The close path's reason, when it refused. */
  jobStaysOpenReason: string | null;
  /** The job's status now ("Done" if this finished it). */
  jobStatus: string;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

async function rollback(connection: Connection): Promise<void> {
  await rollbackTransaction(connection).catch(() => undefined);
}

/**
 * Marks a next step done. Throws RequestError (and EscalationError and
 * LedgerValidationError) for anything the person can act on; anything else is a
 * failure and the transaction has been rolled back.
 */
export async function completeNextStep(connection: Connection, context: CompleteContext, input: CompleteInput): Promise<CompletedOutcome> {
  const now = context.now ?? new Date();
  const { actor } = context;

  const seen = await getDecisionRow(connection, input.decisionId);
  if (!seen) throw new RequestError("not_found", "That decision doesn't exist.", 404);

  await beginTransaction(connection);
  try {
    // The job first, as every writer here takes them.
    const job = await lockJob(connection, seen.jobId);
    if (!job) throw new RequestError("job_not_found", "That job doesn't exist.", 404);
    const decision = await getDecisionRow(connection, input.decisionId, { forUpdate: true });
    if (!decision) throw new RequestError("not_found", "That decision doesn't exist.", 404);

    const users = await listActiveUsers(connection);
    const ownerName = users.find((user) => user.userId === decision.nextStepOwnerUserId)?.name ?? null;
    const standing = stepStanding(decision, { roles: context.roles, userId: actor.userId }, ownerName);
    if (!standing.allowed) throw new RequestError("not_next_step_owner", standing.message, 403);

    if (decision.nextStep === null) {
      throw new RequestError("no_next_step", "That decision didn't hand on a next step, so there is nothing to mark done.", 409, { decision });
    }
    if (decision.nextStepClosed) {
      throw decision.nextStepClosed.kind === "replaced"
        ? new RequestError("step_replaced", "A later decision took over from this step, so it can't be marked done.", 409, { decision })
        : new RequestError("already_done", `This step was already marked done by ${decision.nextStepClosed.byName}.`, 409, { decision });
    }
    if (input.rowVersion !== null && input.rowVersion !== decision.rowVersion) {
      throw new RequestError("stale", "Someone else changed this decision. Reload it to see their change.", 409, { decision });
    }

    const correlationId = newCorrelationId();
    if (!(await closeNextStep(connection, decision.decisionId, { at: now, byId: actor.userId, byName: actor.name, expectedRowVersion: input.rowVersion, kind: "done", note: input.note }))) {
      throw new RequestError("stale", "Someone else changed this decision. Reload it to see their change.", 409, { decision });
    }

    // The owner, their manager and a director stop being told.
    const live = await findLiveEscalation(connection, "job", String(job.jobId), NEXT_STEP_POLICY);
    if (live && nextStepOf(live)?.decisionId === decision.decisionId) {
      await resolveWithin(connection, { actor, correlationId, escalationId: live.escalationId, note: input.note, now, resolutionCode: "next_step_done" });
    }

    await insertJobEvent(connection, {
      createdBy: actor.name,
      eventType: "decision",
      jobId: job.jobId,
      text: `${actor.name} marked the next step done: ${clip(oneLine(decision.nextStep), 300)}${input.note ? `\n${input.note}` : ""}`,
    });

    // The job is finished if this was the last thing it was waiting for.
    let jobClosed = false;
    let jobStaysOpen: JobStaysOpen | null = null;
    let jobStaysOpenReason: string | null = null;
    if (job.isArchived || job.status === "Done") {
      jobStaysOpen = "already_closed";
    } else if (decision.outcome === "revise") {
      jobStaysOpen = "revise";
    } else if (decision.outcome === "defer") {
      jobStaysOpen = "deferred";
    } else if (job.kind !== ADMIN_KIND) {
      jobStaysOpen = "refused";
      jobStaysOpenReason = "Only an Admin / Accounts job is finished by its decision's next step.";
    } else if (await findPending(connection, job.jobId)) {
      jobStaysOpen = "pending_request";
    } else if ((await openNextSteps(connection, job.jobId)).length > 0) {
      jobStaysOpen = "other_step";
    } else if (await hasScheduledReask(connection, job.jobId)) {
      jobStaysOpen = "deferred";
    } else {
      const closed = await closeInternalJobWithin(connection, {
        actorName: actor.name,
        jobId: job.jobId,
        roles: context.roles,
        text: `Next step done: ${clip(oneLine(decision.nextStep), 300)}${input.note ? ` (${clip(oneLine(input.note), 200)})` : ""}`,
      });
      jobClosed = closed.closed;
      if (!closed.closed) {
        jobStaysOpen = "refused";
        jobStaysOpenReason = closed.reason;
      }
    }

    const done = await getDecisionRow(connection, decision.decisionId);
    if (!done) throw new Error(`decision ${decision.decisionId} vanished inside its own transaction`);
    await record(connection, {
      action: "decision.next_step_done",
      actor,
      after: decisionSnapshot(done, { doneAs: standing.as, jobClosed, jobStaysOpen }),
      before: decisionSnapshot(decision),
      buildingId: job.buildingId,
      correlationId,
      jobId: job.jobId,
      reason: input.note,
      ruleApplied: `next_step.${standing.as}`,
      subject: { id: job.jobId, type: "job" },
    });
    await commitTransaction(connection);
    return { decision: done, jobClosed, jobId: job.jobId, jobStaysOpen, jobStaysOpenReason, jobStatus: jobClosed ? "Done" : job.status };
  } catch (error) {
    await rollback(connection);
    if (error instanceof RequestError && error.code === "not_next_step_owner") {
      await recordRefusal(
        connection,
        actor,
        { id: seen.jobId, type: "job" },
        { attempted: "decision.next_step_done", code: "not_next_step_owner", message: error.message, state: { decisionId: seen.decisionId, outcome: seen.outcome } },
        seen.jobId,
      );
    }
    throw error;
  }
}
