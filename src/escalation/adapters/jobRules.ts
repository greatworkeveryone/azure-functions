// When a job needs escalating, as pure rules over a snapshot of the job (PLAN
// §3.7 policy table). The same rule decides both ways: the sweep raises an
// escalation when it turns true and ends it (condition_cleared) when it turns
// false, so a rule can't raise something it would immediately clear.
//
// Thresholds:
//   stalled     the WP18a per-priority days (ESCALATION_THRESHOLD_DAYS_*, in
//               plannerHelpers) since the later of acknowledgement, status
//               change or creation, on an assigned job still moving through
//               New / Quote / Work / Awaiting Approval
//   unassigned  one business day (8 business hours) since the job was created
//   quote       3 business days since a quote was first requested, or 1 for
//               Critical and High, with no quote received
//   invoice     5 business days since an invoice arrived, still undecided
//   past due    the job's next-update date (Jobs.ExpectedProgressUpdate) is
//               before today in Darwin; the job has no separate due date, and
//               that date defaults to a week out, so the policy is seeded
//               inactive until Jobs has a real one
//
// Each sweep policy also names the job kinds it applies to (POLICY_JOB_KINDS), and
// a job of any other kind never meets it.

import { CONTRACTOR_FLOW_KINDS } from "../../jobKinds";
import { formatDarwinDateTime } from "../../ledger/darwinTime";
import { escalationThresholdDays } from "../../plannerHelpers";
import { addBusinessHours, businessDaysToHours, darwinDateKey, type Holidays } from "../businessTime";

/** A job as the rules see it. */
export interface JobFacts {
  acknowledgedAt: Date | null;
  assigned: boolean;
  assignedTo: string | null;
  buildingId: number | null;
  buildingName: string | null;
  createdAt: Date;
  expectedProgressUpdate: Date | null;
  /** When the first contractor was requested for a quote (JobRequestedContractors.AddedAt). */
  firstQuoteRequestAt: Date | null;
  isArchived: boolean;
  jobId: number;
  /** Jobs.Kind; which sweep policies apply to the job follows from it. */
  kind: string;
  /** Incoming invoices still 'pending', and when the oldest arrived. */
  oldestPendingInvoiceAt: Date | null;
  pendingInvoices: number;
  priority: string | null;
  quoteCount: number;
  requestedContractors: number;
  status: string;
  statusSince: Date | null;
  title: string;
}

/** Statuses where the assignee still has the next move (the WP18a set). Tenant
 *  is a block on someone outside; Done is finished. */
export const STALL_STATUSES: readonly string[] = ["New", "Quote", "Work", "Awaiting Approval"];

const DAY_MS = 86_400_000;

export const isLiveJob = (job: JobFacts): boolean => !job.isArchived && job.status !== "Done";

/** The start of a job's stall window: the later of acknowledgement and status
 *  change as the WP18a evaluator had it (COALESCE order), else creation. */
export function stallClockStart(job: JobFacts): Date {
  return job.acknowledgedAt ?? job.statusSince ?? job.createdAt;
}

export function stallThresholdDays(job: JobFacts, env: NodeJS.ProcessEnv = process.env): number {
  return escalationThresholdDays(job.priority, env);
}

export function isStalled(job: JobFacts, now: Date, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isLiveJob(job) || !job.assigned || !STALL_STATUSES.includes(job.status)) return false;
  return now.getTime() - stallClockStart(job).getTime() > stallThresholdDays(job, env) * DAY_MS;
}

export function isUnassigned(job: JobFacts, now: Date, holidays: Holidays): boolean {
  if (!isLiveJob(job) || job.assigned) return false;
  return addBusinessHours(job.createdAt, businessDaysToHours(1), holidays).getTime() <= now.getTime();
}

/** Business days to wait for a quote: 3, or 1 for Critical and High. */
export function quoteWaitDays(job: Pick<JobFacts, "priority">): number {
  return job.priority === "Critical" || job.priority === "High" ? 1 : 3;
}

export function isQuoteNotBack(job: JobFacts, now: Date, holidays: Holidays): boolean {
  if (!isLiveJob(job) || (job.status !== "New" && job.status !== "Quote")) return false;
  if (job.requestedContractors === 0 || job.quoteCount > 0 || !job.firstQuoteRequestAt) return false;
  return addBusinessHours(job.firstQuoteRequestAt, businessDaysToHours(quoteWaitDays(job)), holidays).getTime() <= now.getTime();
}

export const INVOICE_WAIT_DAYS = 5;

export function isInvoiceWaiting(job: JobFacts, now: Date, holidays: Holidays): boolean {
  if (!isLiveJob(job) || job.pendingInvoices === 0 || !job.oldestPendingInvoiceAt) return false;
  return addBusinessHours(job.oldestPendingInvoiceAt, businessDaysToHours(INVOICE_WAIT_DAYS), holidays).getTime() <= now.getTime();
}

/** Past due once the due day has ended in Darwin. */
export function isPastDue(job: JobFacts, now: Date): boolean {
  if (!isLiveJob(job) || !job.expectedProgressUpdate) return false;
  return darwinDateKey(job.expectedProgressUpdate) < darwinDateKey(now);
}

export const isCriticalJob = (job: JobFacts): boolean => isLiveJob(job) && job.priority === "Critical";

/** The sweep's job policies, in the order they are evaluated. */
export const SWEEP_JOB_POLICIES = [
  "job.stalled_unacknowledged",
  "job.unassigned",
  "job.quote_not_back",
  "job.invoice_waiting",
  "job.past_due",
] as const;
export type SweepJobPolicy = (typeof SWEEP_JOB_POLICIES)[number];

/**
 * The job kinds each sweep policy applies to, chosen policy by policy. A job of a
 * kind that isn't listed never meets the policy, both ways: the sweep doesn't
 * raise it and ends one it finds (condition_cleared). All five follow the
 * facilities and maintenance work (an assignee, contractor quotes, invoice
 * approval, and ladders that run to the facilities and accounts managers). An
 * Admin / Accounts job (plan D2) has no quote, PO or invoice, and the clock that
 * chases it is the tier its raiser chose (D5), not these priority thresholds, so
 * it is on none of them. To chase another kind, list it here; never subtract.
 */
export const POLICY_JOB_KINDS: Readonly<Record<SweepJobPolicy, readonly string[]>> = {
  "job.stalled_unacknowledged": CONTRACTOR_FLOW_KINDS,
  "job.unassigned": CONTRACTOR_FLOW_KINDS,
  "job.quote_not_back": CONTRACTOR_FLOW_KINDS,
  "job.invoice_waiting": CONTRACTOR_FLOW_KINDS,
  "job.past_due": CONTRACTOR_FLOW_KINDS,
};

/** Whether a policy applies to a job of this kind. job.critical and the manual
 *  policies aren't sweep policies: the job save or a person raised them, for any kind. */
export function policyAppliesToKind(policyKey: string, kind: string): boolean {
  if (!Object.hasOwn(POLICY_JOB_KINDS, policyKey)) return true;
  return POLICY_JOB_KINDS[policyKey as SweepJobPolicy].includes(kind);
}

export interface RuleContext {
  env?: NodeJS.ProcessEnv;
  holidays: Holidays;
  now: Date;
}

/** Whether a job meets a job policy's condition right now. */
export function jobConditionActive(policyKey: string, job: JobFacts, context: RuleContext): boolean {
  if (!policyAppliesToKind(policyKey, job.kind)) return false;
  switch (policyKey) {
    case "job.stalled_unacknowledged":
      return isStalled(job, context.now, context.env);
    case "job.unassigned":
      return isUnassigned(job, context.now, context.holidays);
    case "job.quote_not_back":
      return isQuoteNotBack(job, context.now, context.holidays);
    case "job.invoice_waiting":
      return isInvoiceWaiting(job, context.now, context.holidays);
    case "job.past_due":
      return isPastDue(job, context.now);
    case "job.critical":
      return isCriticalJob(job);
    // Raised by a person (or the write path): it lasts while the job is live.
    case "job.manual":
    case "any.manual":
      return isLiveJob(job);
    default:
      return false;
  }
}

/** The start of the window a condition is measured from. A person who closes an
 *  escalation for it is not asked again until this moves (the job is
 *  acknowledged, changes status, gets a new date, a new invoice), so the sweep
 *  does not re-raise what someone already dealt with. */
export function conditionEpoch(policyKey: SweepJobPolicy, job: JobFacts): Date | null {
  switch (policyKey) {
    case "job.stalled_unacknowledged":
      return stallClockStart(job);
    case "job.unassigned":
      return job.createdAt;
    case "job.quote_not_back":
      return job.firstQuoteRequestAt;
    case "job.invoice_waiting":
      return job.oldestPendingInvoiceAt;
    case "job.past_due":
      return job.expectedProgressUpdate;
  }
}

const formatDate = (date: Date): string => formatDarwinDateTime(date).slice(0, 10);

/** What the escalation says about the job, after the job's name. */
export function jobHeadline(policyKey: string, job: JobFacts, now: Date): string {
  switch (policyKey) {
    case "job.stalled_unacknowledged": {
      const days = Math.max(1, Math.floor((now.getTime() - stallClockStart(job).getTime()) / DAY_MS));
      return `Stalled: no acknowledgement or update for ${days} day${days === 1 ? "" : "s"}`;
    }
    case "job.unassigned":
      return "Needs an owner: no one is assigned";
    case "job.quote_not_back": {
      const days = quoteWaitDays(job);
      return `No quote back ${days} business day${days === 1 ? "" : "s"} after it was requested`;
    }
    case "job.invoice_waiting":
      return job.oldestPendingInvoiceAt
        ? `Invoice waiting for a decision since ${formatDate(job.oldestPendingInvoiceAt)}`
        : "Invoice waiting for a decision";
    case "job.past_due":
      return job.expectedProgressUpdate ? `Past due: the next update was due ${formatDate(job.expectedProgressUpdate)}` : "Past due";
    case "job.critical":
      return "Critical job: needs attention now";
    default:
      return "Needs attention";
  }
}
