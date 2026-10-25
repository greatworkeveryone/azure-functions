// A deferred question comes back (jobs plan A2). When a decision-maker defers, the
// day they name is written on the decision (DeferUntil). On that morning the
// escalation sweep asks the same people again: a NEW pending decision request, with
// its own escalation, emails, reminders and move-up, exactly as if the person who
// first asked had asked it that day. Why a new request and not a timer on the old
// one: answering needs a pending request to answer, and everything the platform does
// for a question (the inbox, the reminders, the chase, the ledger) already hangs off
// one.
//
// Exactly once, however many sweeps run:
//   - the decision is stamped with the request it produced (ReaskRequestId, unique)
//     in the same transaction that creates the request, and only if it was not
//     already (UPDATE ... WHERE ReaskRequestId IS NULL);
//   - a job has one pending request at a time (the filtered unique index), so a
//     second sweep at the same moment cannot add another;
//   - a deferral is only asked again if the job has no request since it: a person
//     who asked again by hand has already done it, and the sweep leaves them be.
// The sweep re-checks all of that under the job's lock, so what listed a deferral as
// due is not trusted.
//
// The new request keeps who asked and who was asked. A role-wide question goes to
// whoever holds the role now; a named one to the people named who can still be asked.
// How long they are given is the original tier counted from today (followUp.ts). It is
// raised by the sweep (the ledger says Floorplan did it, under decision_request.reask),
// for the person who first asked: their name is on it, and it moves up to their
// manager if nobody answers.

import type { Connection } from "tedious";
import { beginTransaction, commitTransaction, rollbackTransaction } from "../db";
import { jobLabel } from "../escalation/adapters/job";
import { holidaysFromEnv, type Holidays } from "../escalation/businessTime";
import { DECISION_PENDING_POLICY } from "../escalation/decisionRows";
import { raiseWithin, SWEEP_ACTOR } from "../escalation/engine";
import { isUniqueViolation } from "../escalation/errors";
import type { NotifyOptions } from "../escalation/notifier";
import { normaliseRole } from "../escalation/roles";
import { listActiveUsers } from "../escalation/store";
import type { DirectoryUser, EscalationRow } from "../escalation/types";
import { newCorrelationId, record } from "../ledger";
import { getDecisionRow, hasLaterRequest, stampReask, type DueDeferral } from "./decisionsStore";
import { followUpSchedule } from "./followUp";
import { resolveDecisionMakers, type ResolvedMakers } from "./people";
import { RequestError } from "./request";
import { DECISION_MAKER_ROLES } from "./roles";
import { requestSnapshot } from "./service";
import { getRequestRow, insertRequest, lockJob, type DecisionRequestRow } from "./store";

export type ReaskResult = "asked" | "skipped";

export interface ReaskOptions {
  holidays?: Holidays;
  notify?: NotifyOptions;
  now: Date;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Who the question goes to the second time. A role-wide one: whoever holds the role
 * now, leaving the person who asked out. A named one: the people named who are still
 * active and can still open the escalation inbox; if none can, a 422 (and the sweep
 * tries again next run, and tells admin, until a person asks by hand).
 */
export function reaskMakers(original: DecisionRequestRow, directory: readonly DirectoryUser[]): ResolvedMakers {
  if (original.assignmentMode === "role" && original.decisionMakers.role) {
    return resolveDecisionMakers({ mode: "role", role: original.decisionMakers.role }, directory, original.requestedByUserId);
  }
  const stillAskable = original.decisionMakers.userIds.filter((id) =>
    directory.some((user) => user.userId === id && DECISION_MAKER_ROLES.includes(normaliseRole(user.role))),
  );
  if (stillAskable.length === 0) {
    throw new RequestError("decision_maker_unknown", "Nobody this question was put to can be asked any more, so it can't come back to them.", 422);
  }
  return resolveDecisionMakers({ mode: "named", userIds: stillAskable }, directory, original.requestedByUserId);
}

async function rollback(connection: Connection): Promise<void> {
  await rollbackTransaction(connection).catch(() => undefined);
}

/**
 * Asks a deferred question again. Returns "skipped" (writing nothing) when it is not
 * due after all: asked already, the job closed, a request since. Throws for anything
 * else (nobody to ask, the policy switched off): the transaction has been rolled back
 * and the sweep reports it.
 */
export async function reaskDeferral(connection: Connection, deferral: DueDeferral, options: ReaskOptions): Promise<ReaskResult> {
  const { now } = options;
  const holidays = options.holidays ?? holidaysFromEnv();

  await beginTransaction(connection);
  let announce: () => Promise<EscalationRow>;
  try {
    const job = await lockJob(connection, deferral.jobId);
    const decision = await getDecisionRow(connection, deferral.decisionId, { forUpdate: true });
    const original = decision ? await getRequestRow(connection, decision.requestId) : null;
    if (
      !job ||
      !decision ||
      !original ||
      decision.outcome !== "defer" ||
      decision.reaskRequestId !== null ||
      job.isArchived ||
      job.status === "Done" ||
      (await hasLaterRequest(connection, job.jobId, decision.requestId))
    ) {
      await rollback(connection);
      return "skipped";
    }

    const users = await listActiveUsers(connection);
    const makers = reaskMakers(original, users);
    const schedule = followUpSchedule(original, "reask", now, holidays);
    const correlationId = newCorrelationId();

    const requestId = await insertRequest(connection, {
      assignmentMode: original.assignmentMode,
      autoEscalate: schedule.autoEscalate,
      decisionMakers: { role: makers.role, userIds: makers.userIds },
      jobId: job.jobId,
      question: original.question,
      requestedBy: original.requestedBy,
      requestedByUserId: original.requestedByUserId,
      respondBy: schedule.respondBy,
      routineWeeks: schedule.routineWeeks,
      sourceAttachmentId: original.sourceAttachmentId,
      tier: schedule.tier,
    });
    if (!(await stampReask(connection, decision.decisionId, requestId))) {
      await rollback(connection);
      return "skipped";
    }

    // For the person who first asked, if they can still be found: their manager is who
    // it moves up to, as it would have the first time.
    const asker = original.requestedByUserId === null ? undefined : users.find((user) => user.userId === original.requestedByUserId);
    const reaskOf = { askedBy: original.requestedBy, decisionId: decision.decisionId, deferredUntil: decision.deferUntil ?? deferral.deferUntil };
    const label = jobLabel({ buildingName: job.buildingName, jobId: job.jobId, title: job.title });
    const raised = await raiseWithin(connection, {
      actor: SWEEP_ACTOR,
      context: {
        decision: {
          assignmentMode: original.assignmentMode,
          autoEscalate: schedule.autoEscalate,
          callThem: false,
          jobLabel: label,
          question: original.question,
          reaskOf,
          requestId,
          respondBy: schedule.respondBy ? schedule.respondBy.toISOString() : null,
          tier: schedule.tier,
        },
        schedule: {
          escalateAt: schedule.escalateAt ? schedule.escalateAt.toISOString() : null,
          remindAt: schedule.remindAt.map((at) => at.toISOString()),
        },
      },
      correlationId,
      dueAt: schedule.escalateAt,
      headline: `Decision needed (asked again): ${oneLine(original.question)}`,
      ladderRaiser: asker ? { role: normaliseRole(asker.role), userId: asker.userId } : undefined,
      note: original.question,
      notify: options.notify ?? { attempts: 1 },
      now,
      policyKey: DECISION_PENDING_POLICY,
      reason: "needs_decision",
      subjectId: String(job.jobId),
      subjectType: "job",
      urgent: schedule.urgent,
      userTargets: makers.userIds,
    });
    if (!raised.created) {
      // Something else is already chasing a decision on this job: it is not ours to add to.
      await rollback(connection);
      return "skipped";
    }
    announce = raised.announce;

    const request = await getRequestRow(connection, requestId);
    if (!request) throw new Error(`decision request ${requestId} vanished inside its own transaction`);
    await record(connection, {
      action: "decision.requested",
      actor: SWEEP_ACTOR,
      after: { ...requestSnapshot(request, schedule), reaskOf },
      buildingId: job.buildingId,
      correlationId,
      jobId: job.jobId,
      ruleApplied: "decision_request.reask",
      subject: { id: job.jobId, type: "job" },
    });
    await commitTransaction(connection);
  } catch (error) {
    await rollback(connection);
    // Another sweep (or a person asking by hand) got in first.
    if (isUniqueViolation(error)) return "skipped";
    throw error;
  }

  await announce();
  return "asked";
}
