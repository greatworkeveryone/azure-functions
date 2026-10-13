// job.critical from the job write path (PLAN §3.7): a job created, or
// re-prioritised, to Critical raises an urgent escalation at once, on the wall
// clock (facilities_manager at 2h, then director at 4h). It is not left to the
// sweep, so an emergency doesn't wait up to half an hour.
//
// The job save has already committed when this runs, so nothing here can fail or
// slow it: errors are logged and sent to Sentry, and the caller carries on. The
// escalation itself is one transaction with its ledger row (engine.raise).

import type { HttpRequest } from "@azure/functions";
import type { Connection } from "tedious";
import { resolveLedgerActor } from "../ledger/actor";
import { Sentry } from "../sentry";
import { raise } from "./engine";

export const CRITICAL_PRIORITY = "Critical";
export const CRITICAL_POLICY = "job.critical";

/** A job that is Critical now and was not before (a new job has no before). */
export function shouldRaiseCritical(previousPriority: unknown, priority: unknown): boolean {
  return priority === CRITICAL_PRIORITY && previousPriority !== CRITICAL_PRIORITY;
}

export interface CriticalJobArgs {
  connection: Connection;
  jobId: number;
  log?: (message: string) => void;
  /** Null for a new job. */
  previousPriority: unknown;
  /** The Priority in the saved payload, undefined when it wasn't part of it. */
  priority: unknown;
  request: HttpRequest;
}

export async function raiseCriticalJobEscalation(args: CriticalJobArgs): Promise<void> {
  if (!shouldRaiseCritical(args.previousPriority, args.priority)) return;
  try {
    const actor = await resolveLedgerActor(args.request, args.connection);
    if (!actor) return;
    await raise(args.connection, {
      actor,
      headline: `Marked Critical by ${actor.kind === "user" ? actor.name : "Floorplan"}`,
      notify: { attempts: 1 },
      policyKey: CRITICAL_POLICY,
      subjectId: String(args.jobId),
      subjectType: "job",
    });
  } catch (error) {
    args.log?.(`job.critical escalation for job #${args.jobId} failed: ${error instanceof Error ? error.message : String(error)}`);
    Sentry.captureException(error, { extra: { jobId: args.jobId }, tags: { source: "job_critical_escalation" } });
  }
}
