// The tenancy side of a review decision (PLAN §3.1 APPLY, WAIVE, REVERT): the
// locked tenant row read the same way every time, the lease's terms as the
// review compares them, and the one UPDATE that writes the schedule.
//
// The UPDATE is the schedule engine's write without U2's manual-edit clearing:
// it bumps ScheduleVersion (a review calculated before it is stale, C4),
// re-derives NextReviewDate, stamps who changed the tenancy, and leaves the
// sign-off columns alone. A rent review is the workflow the sign-off exists for,
// not a manual edit of a verified schedule (D7: "review-workflow applies do not
// [clear it]").

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery, type SqlParam, type SqlRow } from "../db";
import { deriveNextReviewDate, nextReviewInputFromRow, RESOLVED_REVIEW_DATES_SQL, sqlDateToIso } from "../nextReviewDate";
import type { LeaseTermsForReview } from "../rentReviewCalc";
import {
  parseGroups,
  parseMiscFees,
  type CarparkScheduleGroup,
  type MiscFee,
  type ScheduledRateStep,
} from "../scheduledRateStepLogic";
import { parseReliefs, type RentRelief } from "../scheduleCharges";
import { scheduleTermsOf } from "../scheduleTerms";
import { RentReviewError, tenancyArchived } from "./http";
import type { ScheduleContext } from "./stepPlan";

const MONEY = { precision: 20, scale: 10 } as const;
const PERCENT = { precision: 13, scale: 10 } as const;

export const decimalOf = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const isArchived = (row: SqlRow): boolean => row.ArchivedAt !== null && row.ArchivedAt !== undefined;

/** WP25's 422s: an archived tenancy's reviews are history until it is restored,
 *  and a vacated one's can't be decided (CANCEL passes allowVacated: cancelling
 *  is how a vacated tenancy's review is closed). */
export function refuseClosedTenancy(row: SqlRow, options: { allowVacated?: boolean } = {}): void {
  if (isArchived(row)) throw tenancyArchived();
  if (row.Status === "vacated" && !options.allowVacated) {
    throw new RentReviewError("tenancy_vacated", "This tenancy has been vacated, so its rent review can't be changed.");
  }
}

export function isReviewRatchetOn(row: SqlRow): boolean {
  return row.ReviewRatchet === true || row.ReviewRatchet === 1;
}

/** The lease's terms on the tenancy, as SUBMIT compares a review's basis with them. */
export function leaseTermsOf(row: SqlRow, stepOnReviewDate: ScheduledRateStep | null): LeaseTermsForReview {
  const leaseFixed = decimalOf(row.FixedReviewPercent);
  return {
    cpiCapPercent: decimalOf(row.CpiCapPercent),
    cpiFloorPercent: decimalOf(row.CpiFloorPercent),
    cpiReferenceRule: typeof row.CpiReferenceQuarterRule === "string" ? row.CpiReferenceQuarterRule : null,
    cpiRegion: typeof row.CpiRegion === "string" ? row.CpiRegion : null,
    fixedPercent: leaseFixed ?? (stepOnReviewDate?.methodKind === "fixed" ? stepOnReviewDate.ratePercent : null),
    reviewIntervalMonths: decimalOf(row.ReviewIntervalMonths),
    reviewRatchet: isReviewRatchetOn(row),
  };
}

export interface ReviewSchedule {
  carparkGroups: CarparkScheduleGroup[];
  context: ScheduleContext;
  miscFees: MiscFee[];
  /** The ratified rent reliefs (Tenants.RentReliefs, WP26c): a review's arrears for a relieved day are the relieved difference. */
  reliefs: RentRelief[];
}

/** What the schedule engine needs about the tenancy, with these steps. */
export function scheduleOf(row: SqlRow, steps: ScheduledRateStep[], totalSqm: number): ReviewSchedule {
  return {
    carparkGroups: parseGroups(row.CarparkScheduleGroups as string | null | undefined),
    context: {
      fallbackAnnual: decimalOf(row.RentPerAnnum) ?? 0,
      fallbackSqm: totalSqm,
      // The lease's cap, floor and ratchet, and REVIEW_WORKFLOW_LIVE_FROM (M2).
      lease: scheduleTermsOf(row),
      steps,
    },
    miscFees: parseMiscFees(row.MiscFees as string | null | undefined),
    reliefs: parseReliefs(row.RentReliefs as string | null | undefined),
  };
}

/** The tenancy's settled review dates as they stand now, inside the transaction
 *  (after this request changed a review's state). */
export async function resolvedReviewDatesNow(connection: Connection, tenantId: number): Promise<unknown> {
  const rows = await executeQuery(
    connection,
    `SELECT ${RESOLVED_REVIEW_DATES_SQL} FROM dbo.Tenants t WHERE t.TenantId = @TenantId`,
    [{ name: "TenantId", type: TYPES.Int, value: tenantId }],
  );
  return rows[0]?.ResolvedReviewDates ?? null;
}

/** NextReviewDate as a write leaves the tenancy (PLAN D1), or null when there is
 *  nothing to derive it from or it doesn't move. */
export function derivedNextReview(
  locked: SqlRow,
  steps: ScheduledRateStep[],
  changes: { lastReviewDate?: string | null; resolvedReviewDates?: unknown },
  today: string,
): { after: string; before: string | null } | null {
  const input = nextReviewInputFromRow(
    {
      ...locked,
      ...(changes.lastReviewDate !== undefined ? { LastReviewDate: changes.lastReviewDate } : {}),
      ...(changes.resolvedReviewDates !== undefined ? { ResolvedReviewDates: changes.resolvedReviewDates } : {}),
    },
    steps,
    today,
  );
  const derived = deriveNextReviewDate(input);
  if (derived === null || derived === input.storedNextReviewDate) return null;
  return { after: derived, before: input.storedNextReviewDate };
}

export interface TenancyWrite {
  actorName: string;
  /** Who, by Entra object id, for Tenants.UpdatedById. */
  actorOid: string;
  lastReviewDate?: string | null;
  lastReviewIncreasePercent?: number | null;
  nextReviewDate: string | null;
  /** The RentPerAnnum cache; left as it is when undefined. */
  rentPerAnnum?: number | null;
  steps: ScheduledRateStep[];
  tenantId: number;
}

/** The schedule write of a review decision: the steps, ScheduleVersion + 1, the
 *  review fields given, NextReviewDate when it moved. Sign-off is untouched (D7).
 *  Returns the new ScheduleVersion. */
export async function writeTenancyForReview(connection: Connection, write: TenancyWrite): Promise<number> {
  const sets = ["ScheduledRateSteps = @Steps"];
  const params: SqlParam[] = [
    { name: "TenantId", type: TYPES.Int, value: write.tenantId },
    { name: "Steps", type: TYPES.NVarChar, value: JSON.stringify(write.steps) },
    { name: "UpdatedById", type: TYPES.NVarChar, value: write.actorOid },
    { name: "UpdatedByName", type: TYPES.NVarChar, value: write.actorName },
  ];
  if (write.lastReviewDate !== undefined) {
    sets.push("LastReviewDate = @LastReviewDate");
    params.push({ name: "LastReviewDate", type: TYPES.Date, value: write.lastReviewDate });
  }
  if (write.lastReviewIncreasePercent !== undefined) {
    sets.push("LastReviewIncreasePercent = @LastReviewIncreasePercent");
    params.push({ name: "LastReviewIncreasePercent", options: PERCENT, type: TYPES.Decimal, value: write.lastReviewIncreasePercent });
  }
  if (write.rentPerAnnum !== undefined) {
    sets.push("RentPerAnnum = @RentPerAnnum");
    params.push({ name: "RentPerAnnum", options: MONEY, type: TYPES.Decimal, value: write.rentPerAnnum });
  }
  if (write.nextReviewDate !== null) {
    sets.push("NextReviewDate = @NextReviewDate");
    params.push({ name: "NextReviewDate", type: TYPES.Date, value: write.nextReviewDate });
  }
  const setClause = sets.join(", ");
  const rows = await executeQuery(
    connection,
    `UPDATE dbo.Tenants SET ${setClause},
       ScheduleVersion = ScheduleVersion + 1,
       UpdatedAt = SYSUTCDATETIME(),
       UpdatedById = @UpdatedById,
       UpdatedByName = @UpdatedByName
     OUTPUT INSERTED.ScheduleVersion
     WHERE TenantId = @TenantId`,
    params,
  );
  return Number(rows[0]?.ScheduleVersion);
}

/** The tenancy's review fields as a ledger snapshot. */
export function tenancyReviewFields(row: SqlRow): {
  lastReviewDate: string | null;
  lastReviewIncreasePercent: number | null;
  nextReviewDate: string | null;
  rentPerAnnum: number | null;
  scheduleVersion: number;
} {
  return {
    lastReviewDate: sqlDateToIso(row.LastReviewDate),
    lastReviewIncreasePercent: decimalOf(row.LastReviewIncreasePercent),
    nextReviewDate: sqlDateToIso(row.NextReviewDate),
    rentPerAnnum: decimalOf(row.RentPerAnnum),
    scheduleVersion: Number(row.ScheduleVersion ?? 0),
  };
}
