// Pure shaping for GET /api/getTenancyActivity (PLAN §15, TR5): one newest-first
// list of a tenancy's work requests, jobs and on-charges. No SQL and no money
// maths here: an on-charge's amount is the job's own OnchargeAmount, copied as is,
// so the list can never disagree with the job record (no second ledger).

import { AppRole } from "../auth";
import { JobStatus } from "../jobStatusMachine";

export const ACTIVITY_CAP = 200;

/** Roles that see on-charge amounts here: the roles that see them on a job and may read a tenancy. */
export const ACTIVITY_AMOUNT_ROLES: readonly AppRole[] = [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR];

export type ActivityType = "invoice" | "job" | "on_charge" | "work_request";

export interface ActivityItem {
  /** Only when a source says so (TR1's WorkRequests.IntakeState); otherwise absent. */
  intakeState?: string;
  amount: number | null;
  /** ISO timestamp the row was created. */
  date: string | null;
  id: string;
  isOpen: boolean;
  jobId: number | null;
  /** Job code or work request number, as staff know it. */
  reference: string;
  source: "floorplan" | "mybuildings" | null;
  status: string;
  title: string;
  type: ActivityType;
  workRequestId: number | null;
}

export interface TenancyActivity {
  /** WP62 seam: no tenant invoice source exists yet, so this is always empty. */
  invoices: ActivityItem[];
  items: ActivityItem[];
  truncated: boolean;
}

type Row = Record<string, unknown>;

const WR_CLOSED = /complete|closed|cancel|declin|resolved|reject/i;

const iso = (value: unknown): string | null => (value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : typeof value === "string" ? value : null);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

export function workRequestItem(row: Row): ActivityItem {
  const id = row.WorkRequestID as number;
  const intakeState = text(row.IntakeState);
  const status = text(row.Status) ?? "Unknown";
  const closed = intakeState ? intakeState === "Closed" || intakeState === "Converted" : WR_CLOSED.test(status);
  return {
    ...(intakeState ? { intakeState } : {}),
    amount: null,
    date: iso(row.CreatedAt),
    id: `wr-${id}`,
    isOpen: !closed,
    jobId: null,
    reference: id < 0 ? `FP-${Math.abs(id)}` : `WR-${id}`,
    source: id < 0 || text(row.SourceHost) === "floorplan" ? "floorplan" : "mybuildings",
    status,
    title: text(row.Details)?.slice(0, 140) ?? text(row.Category) ?? "Work request",
    type: "work_request",
    workRequestId: id,
  };
}

export function jobItems(row: Row, showAmounts: boolean): ActivityItem[] {
  const jobId = row.JobID as number;
  const status = text(row.Status) ?? "Unknown";
  const base = {
    date: iso(row.CreatedAt),
    isOpen: status !== JobStatus.DONE,
    jobId,
    reference: text(row.JobCode) ?? `Job ${jobId}`,
    source: null,
    status,
    title: text(row.Title) ?? "Job",
    workRequestId: (row.WorkRequestID as number | null) ?? null,
  };
  const items: ActivityItem[] = [{ ...base, amount: null, id: `job-${jobId}`, type: "job" }];
  if (row.IsOnchargeable === true || row.IsOnchargeable === 1) {
    const amount = row.OnchargeAmount === null || row.OnchargeAmount === undefined ? null : Number(row.OnchargeAmount);
    items.push({ ...base, amount: showAmounts ? amount : null, id: `oncharge-${jobId}`, title: `On-charge: ${base.title}`, type: "on_charge" });
  }
  return items;
}

/** Newest first, capped. `date` ties break on id so paging stays stable. */
export function buildTenancyActivity(wrRows: Row[], jobRows: Row[], showAmounts: boolean, cap = ACTIVITY_CAP): TenancyActivity {
  const all = [...wrRows.map(workRequestItem), ...jobRows.flatMap((r) => jobItems(r, showAmounts))];
  all.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || a.id.localeCompare(b.id));
  return { invoices: [], items: all.slice(0, cap), truncated: all.length > cap };
}
