// Moving an Admin / Accounts job to Done (jobs plan A2): the in-house close path of
// A0, which is the same move addJobEvent makes for "Finish & Close job". The job is
// read and locked, the transition guard decides on exactly that state, and the event
// and the update are written in the caller's transaction, the update predicated on
// the state the guard decided on. Nothing here is a second rule: the machine and the
// guard are the ones every status change goes through, so a job that cannot be closed
// that way (a role that may not move jobs) cannot be closed this way either.

import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../db";
import { AwaitingRole, JobStatus, resolveManualTarget, type JobState } from "../jobStatusMachine";
import { loadJobForTransition } from "../jobTransitionFacts";
import { guardTransition, type GuardRefusal } from "../jobTransitionGuard";
import { insertJobEvent } from "./decisionsStore";

export type CloseResult =
  | { closed: true }
  | { closed: false; code: GuardRefusal | "job_changed" | "job_not_found"; reason: string };

export interface CloseInput {
  /** The person closing it: the event names them. */
  actorName: string;
  jobId: number;
  /** Their roles now, for the guard. */
  roles: readonly string[];
  /** What the history says. */
  text: string;
}

/**
 * Closes a job in-house. Returns the guard's refusal instead of throwing when the
 * move is not allowed (the caller decides whether that stops its own work); a job
 * that changed between the guard's read and the write comes back as `job_changed`.
 */
export async function closeInternalJobWithin(connection: Connection, input: CloseInput): Promise<CloseResult> {
  const locked = await loadJobForTransition(connection, input.jobId);
  if (!locked) return { closed: false, code: "job_not_found", reason: "That job doesn't exist." };

  const current: JobState = { awaitingRole: locked.current.awaitingRole as AwaitingRole, status: locked.current.status as JobStatus };
  const preBlockState: JobState | undefined = locked.preBlock
    ? { awaitingRole: locked.preBlock.awaitingRole as AwaitingRole, status: locked.preBlock.status as JobStatus }
    : undefined;
  const machineTarget = resolveManualTarget(current, JobStatus.DONE, {
    isContract: locked.facts.isContract,
    isInternal: locked.facts.isInternal,
    preBlockState,
  });
  const decision = guardTransition({
    actor: { kind: "user", roles: input.roles },
    current: locked.current,
    facts: locked.facts,
    machineTarget,
    request: { kind: "manual", target: "Done" },
  });
  if (!decision.allowed) return { closed: false, code: decision.code, reason: decision.reason };

  // The write mirrors addJobEvent's: a real transition resets the accountability clock.
  const moved = await executeQuery(
    connection,
    `UPDATE dbo.Jobs
        SET Status = @Status, AwaitingRole = @AwaitingRole, StatusSince = SYSUTCDATETIME(),
            AcknowledgedAt = NULL, AcknowledgedBy = NULL, EscalatedAt = NULL, LastModifiedDate = SYSUTCDATETIME()
     OUTPUT INSERTED.JobID
     WHERE JobID = @JobID AND Status = @ExpectedStatus AND ISNULL(AwaitingRole, N'facilities') = @ExpectedAwaitingRole`,
    [
      { name: "JobID", type: TYPES.Int, value: input.jobId },
      { name: "Status", type: TYPES.NVarChar, value: decision.to.status },
      { name: "AwaitingRole", type: TYPES.NVarChar, value: decision.to.awaitingRole },
      { name: "ExpectedStatus", type: TYPES.NVarChar, value: current.status },
      { name: "ExpectedAwaitingRole", type: TYPES.NVarChar, value: current.awaitingRole },
    ],
  );
  if (moved.length === 0) {
    return { closed: false, code: "job_changed", reason: "This job changed while it was being closed. Reload it and try again." };
  }
  if (current.status === JobStatus.TENANT) {
    await executeQuery(connection, `UPDATE dbo.Jobs SET PreBlockStatus = NULL, PreBlockAwaitingRole = NULL WHERE JobID = @JobID`, [
      { name: "JobID", type: TYPES.Int, value: input.jobId },
    ]);
  }
  await insertJobEvent(connection, {
    createdBy: input.actorName,
    eventType: "status_change",
    jobId: input.jobId,
    newAwaitingRole: decision.to.awaitingRole,
    newStatus: decision.to.status,
    text: input.text,
  });
  return { closed: true };
}
