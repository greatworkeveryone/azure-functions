// What follows a review decision once it has committed (PLAN §3.1, "after
// commit"), in this order:
//   1. the tenancy's cached register entry is dropped
//   2. the review's escalations whose condition has cleared end with the
//      decision's code (rentReview/escalations.ts)
//   3. SCHEDULE: the tenancy's next review, by the generator's own function
//      (APPLY, WAIVE, and a CANCEL that superseded the review)
//   4. Planner: the tenancy's rent_review tasks are completed (APPLY only), and
//      only while PLANNER_SYNC_ENABLED is "true"
// None of it can undo the decision. A step that fails is logged and sent to
// Sentry, and the rest still run; the generator and the escalation sweep catch
// up on the next run.

import type { Connection } from "tedious";
import type { LedgerActor } from "../ledger";
import { resolveActivePlannerTasks } from "../planner";
import { plannerSyncEnabled } from "../plannerFlag";
import type { RentReviewState } from "../rentReviewMachine";
import { Sentry } from "../sentry";
import { invalidateTenantAndBuilding } from "../tenant-register-cache";
import { settleReviewEscalations } from "./escalations";
import { scheduleNextReview, type ScheduleNextResult } from "./generator";

export interface AfterDecision {
  actor: LedgerActor;
  buildingId: number;
  /** The decision, as the escalations' resolution code. */
  code: string;
  log: (message: string) => void;
  /** The decision's note or reason. */
  note?: string | null;
  /** Complete the tenancy's rent_review Planner tasks (APPLY). */
  plannerResolve?: boolean;
  reviewId: string;
  /** Schedule the tenancy's next review now. */
  scheduleNext?: boolean;
  scheduledFor: string;
  state: RentReviewState;
  tenantId: number;
  today: string;
}

export interface NextReviewRef {
  reviewId: string;
  scheduledFor: string;
  state: RentReviewState;
}

function report(what: string, input: AfterDecision, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  input.log(`rent review ${input.reviewId}: ${what} after the decision failed: ${message}`);
  Sentry.captureException(error, { extra: { context: `rent review after-commit: ${what}`, reviewId: input.reviewId } });
}

/** Runs the after-commit steps; returns the tenancy's open review afterwards when it scheduled one. */
export async function afterReviewDecision(connection: Connection, input: AfterDecision): Promise<NextReviewRef | null> {
  invalidateTenantAndBuilding(input.tenantId, input.buildingId);

  await settleReviewEscalations(connection, {
    actor: input.actor,
    code: input.code,
    log: input.log,
    note: input.note ?? null,
    reviewId: input.reviewId,
    scheduledFor: input.scheduledFor,
    state: input.state,
    today: input.today,
  });

  let next: ScheduleNextResult | null = null;
  if (input.scheduleNext) {
    try {
      next = await scheduleNextReview(connection, input.tenantId, { today: input.today });
    } catch (error) {
      report("scheduling the next review", input, error);
    }
  }

  if (input.plannerResolve && plannerSyncEnabled()) {
    try {
      await resolveActivePlannerTasks("tenant", input.tenantId, ["rent_review"]);
    } catch (error) {
      report("completing the Planner tasks", input, error);
    }
  }

  return next?.review ?? null;
}
