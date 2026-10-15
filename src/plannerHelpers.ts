export type TriggerType =
  | "lease_expiry"
  | "option_notice"
  | "rent_review"
  | "job_update_due"         // legacy — existing tasks only, routes to Facilities
  | "stalled_facilities"     // IsStalled=1 AND AwaitingRole != 'accounts'
  | "awaiting_accounts"      // AwaitingRole = 'accounts'
  | "awaiting_facilities_approval" // Status='Awaiting Approval' AND AwaitingRole='facilities' (quote sign-off)
  | "director_approval"      // DirectorNeededCount > 0
  | "oncharge_pending"       // IsOnchargeable=1 AND no outgoing invoice yet
  | "lost_key_reported";     // key marked lost — pending facilities decision

export const LEAD_TIMES = [90, 60, 30] as const;
export type LeadTime = (typeof LEAD_TIMES)[number];

import { optionNoticeDate } from "./tenancyLeaseEvents";

export interface PlannerTenantRow {
  tenantId: number;
  legalName: string;
  tradingName: string | null;
  buildingName: string;
  firstOccupancy: string | null;
  expiry: string | null;
  optionNoticeMonths: number | null;
  nextReviewDate: string | null;
  reviewType: string | null;
  /** Whether someone has signed this tenancy's schedule off as verified (m097). */
  scheduleSignedOff: boolean;
}

export interface PlannerJobRow {
  jobId: number;
  title: string;
  buildingName: string | null;
  expectedProgressUpdate: string | null;
}

export interface PlannerStalledJobRow {
  jobId: number;
  title: string;
  buildingName: string | null;
  stalledAt: string | null;
  assignedToEntraOid: string | null;
}

export interface PlannerAccountsJobRow {
  jobId: number;
  title: string;
  buildingName: string | null;
}

export interface PlannerOnchargeJobRow {
  jobId: number;
  title: string;
  buildingName: string | null;
  onchargeAmount: number | null;
  onchargeNotes: string | null;
}

export function formatDDMMYYYY(isoDate: string): string {
  const d = new Date(isoDate);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/**
 * The last day to give option notice: the expiry less the notice period,
 * month-end safe (31 Aug less 6 months is 28/29 Feb, never early March), so a
 * reminder never lands after the deadline. Null when either is missing.
 */
function optionDeadlineDate(tenant: PlannerTenantRow): Date | null {
  if (!tenant.expiry || tenant.optionNoticeMonths == null) return null;
  const iso = optionNoticeDate({
    expiry: tenant.expiry.slice(0, 10),
    optionNoticeMonths: tenant.optionNoticeMonths,
  });
  return iso ? new Date(`${iso}T00:00:00Z`) : null;
}

export function addDaysUTC(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export function computeEventDate(
  tenant: PlannerTenantRow,
  triggerType: TriggerType,
): Date | null {
  switch (triggerType) {
    case "lease_expiry":
      return tenant.expiry ? new Date(tenant.expiry) : null;
    case "option_notice":
      return optionDeadlineDate(tenant);
    case "rent_review":
      return tenant.nextReviewDate ? new Date(tenant.nextReviewDate) : null;
    default:
      return null;
  }
}

export function isInWindow(
  today: Date,
  eventDate: Date,
  leadTimeDays: number,
): boolean {
  const todayMs = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  const eventMs = Date.UTC(
    eventDate.getUTCFullYear(),
    eventDate.getUTCMonth(),
    eventDate.getUTCDate(),
  );
  const windowStartMs = eventMs - leadTimeDays * 86_400_000;
  return todayMs >= windowStartMs && todayMs <= eventMs;
}

export function buildTaskTitle(
  displayName: string,
  triggerType: TriggerType,
  leadTimeDays: number,
): string {
  switch (triggerType) {
    case "lease_expiry":
      return `Lease expiry — ${displayName} (${leadTimeDays} days)`;
    case "option_notice":
      return `Option deadline — ${displayName} (${leadTimeDays} days)`;
    case "rent_review":
      return `Rent review — ${displayName} (${leadTimeDays} days)`;
    case "job_update_due":
      return `Update overdue — ${displayName}`;
    case "stalled_facilities":
      return `Job stalled — ${displayName}`;
    case "awaiting_accounts":
      return `Awaiting accounts — ${displayName}`;
    case "awaiting_facilities_approval":
      return `Awaiting approval — ${displayName}`;
    case "director_approval":
      return `Director approval needed — ${displayName}`;
    case "oncharge_pending":
      return `Oncharge — ${displayName}`;
    case "lost_key_reported":
      return `Lost key — ${displayName}`;
  }
}

export function buildTenantTaskDescription(
  tenant: PlannerTenantRow,
  triggerType: TriggerType,
  appBaseUrl: string,
): string {
  const location = [tenant.buildingName, tenant.firstOccupancy]
    .filter(Boolean)
    .join(" | ");
  const prefix = location ? `${location}\n` : "";
  const link = `${appBaseUrl}/tenancy/${tenant.tenantId}`;

  switch (triggerType) {
    case "lease_expiry":
      return `${prefix}Expiry: ${tenant.expiry ? formatDDMMYYYY(tenant.expiry) : "—"}\n${link}`;
    case "option_notice": {
      const due = optionDeadlineDate(tenant);
      const deadline = due ? formatDDMMYYYY(due.toISOString()) : "—";
      return `${prefix}Option deadline: ${deadline}\nLease expiry: ${tenant.expiry ? formatDDMMYYYY(tenant.expiry) : "—"}\n${link}`;
    }
    case "rent_review":
      return `${prefix}Review due: ${tenant.nextReviewDate ? formatDDMMYYYY(tenant.nextReviewDate) : "—"}\nReview type: ${tenant.reviewType ?? "—"}\n${link}`;
    default:
      return link;
  }
}

export function buildJobTaskDescription(
  job: PlannerJobRow,
  appBaseUrl: string,
): string {
  const location = job.buildingName ?? "";
  const due = job.expectedProgressUpdate
    ? formatDDMMYYYY(job.expectedProgressUpdate)
    : "—";
  return `${location ? location + "\n" : ""}Expected update: ${due}\n${appBaseUrl}/jobs`;
}

/** Deep link to a job in the web app. The app has NO `/jobs/:id` path — the
 *  Jobs board is query-param routed and `?jobId=` opens the job modal. Same
 *  format as `buildJobUrl` in email/director-emails.ts; every Planner task that
 *  points at a job must go through here so the links can't drift again. */
export function jobLink(appBaseUrl: string, jobId: number): string {
  return `${appBaseUrl.trim().replace(/\/+$/, "")}/jobs?jobId=${jobId}`;
}

export function buildStalledJobTaskDescription(
  job: PlannerStalledJobRow,
  appBaseUrl: string,
): string {
  const location = job.buildingName ?? "";
  const stalledDate = job.stalledAt ? formatDDMMYYYY(job.stalledAt.slice(0, 10)) : "—";
  return `${location ? location + "\n" : ""}Stalled since: ${stalledDate}\n${jobLink(appBaseUrl, job.jobId)}`;
}

export function buildAwaitingAccountsTaskDescription(
  job: PlannerAccountsJobRow,
  appBaseUrl: string,
): string {
  const location = job.buildingName ?? "";
  return `${location ? location + "\n" : ""}Awaiting accounts action\n${jobLink(appBaseUrl, job.jobId)}`;
}

export function buildAwaitingFacilitiesApprovalTaskDescription(
  job: PlannerAccountsJobRow,
  appBaseUrl: string,
): string {
  const location = job.buildingName ?? "";
  return `${location ? location + "\n" : ""}Quote awaiting approval\n${jobLink(appBaseUrl, job.jobId)}`;
}

export function buildDirectorApprovalTaskDescription(
  job: PlannerAccountsJobRow,
  appBaseUrl: string,
): string {
  const location = job.buildingName ?? "";
  return `${location ? location + "\n" : ""}Invoice or quote requires director sign-off\n${jobLink(appBaseUrl, job.jobId)}`;
}

export function buildOnchargeTaskDescription(
  job: PlannerOnchargeJobRow,
  appBaseUrl: string,
): string {
  const location = job.buildingName ?? "";
  const amount =
    typeof job.onchargeAmount === "number"
      ? `$${job.onchargeAmount.toLocaleString()}`
      : "TBC";
  const notesLine = job.onchargeNotes ? `\nNotes: ${job.onchargeNotes}` : "";
  return `${location ? location + "\n" : ""}On-charge to tenant: ${amount}${notesLine}\n${jobLink(appBaseUrl, job.jobId)}`;
}

// ── Escalation thresholds (WP18a) ────────────────────────────────────────────
// How many days an assigned, un-acknowledged, non-terminal job may sit before
// the escalation sweep (src/escalation, policy job.stalled_unacknowledged)
// escalates it to facilities managers. Keyed by Priority, each env-overridable.
// Defaults: Critical 2 / High 4 / Normal 7 / Low 14; anything else (or an
// unset/garbage priority) falls back to DEFAULT (7).

const DEFAULT_ESCALATION_THRESHOLD_DAYS = 7;

/** Read a positive-integer day count from an env var, or return the fallback
 *  when the var is unset, empty, or not a positive number. */
function readThresholdEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Days a job of the given Priority may age (since the later of last ack /
 *  status change / creation) before escalating. Pure: env is injected so the
 *  function is unit-testable without touching process.env. */
export function escalationThresholdDays(
  priority: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const fallback = readThresholdEnv(
    env,
    "ESCALATION_THRESHOLD_DAYS_DEFAULT",
    DEFAULT_ESCALATION_THRESHOLD_DAYS,
  );
  switch (priority) {
    case "Critical":
      return readThresholdEnv(env, "ESCALATION_THRESHOLD_DAYS_CRITICAL", 2);
    case "High":
      return readThresholdEnv(env, "ESCALATION_THRESHOLD_DAYS_HIGH", 4);
    case "Normal":
      return readThresholdEnv(env, "ESCALATION_THRESHOLD_DAYS_NORMAL", 7);
    case "Low":
      return readThresholdEnv(env, "ESCALATION_THRESHOLD_DAYS_LOW", 14);
    default:
      return fallback;
  }
}

/** Facilities-manager email recipients for escalation, parsed from the
 *  FACILITIES_MANAGER_EMAILS env var (comma-separated). Empty list when unset.
 *  The escalation notifier uses it only while no active facilities_manager
 *  exists. Mirrors getDirectorEmails(). */
export function getFacilitiesManagerEmails(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const raw = env.FACILITIES_MANAGER_EMAILS ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function toIsoDateString(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export interface PlannerLostKeyRow {
  KeyId: number;
  KeyNumber: string;
  BuildingName: string;
  LostAt: Date | null;
  LostByName: string | null;
  LostComment: string | null;
  TenancyName: string | null;
}

export function buildLostKeyTaskDescription(
  row: PlannerLostKeyRow,
  appBaseUrl: string,
): string {
  const reportedAt = row.LostAt ? toIsoDateString(row.LostAt) : "unknown date";
  const reporter = row.LostByName ?? "unknown";
  const tenancy = row.TenancyName ? ` (tenant: ${row.TenancyName})` : "";
  const comment = row.LostComment ? `\n\nReporter note: ${row.LostComment}` : "";
  const link = `${appBaseUrl}/keys/${row.KeyId}`;
  return [
    `${row.KeyNumber} at ${row.BuildingName}${tenancy} was reported lost on ${reportedAt} by ${reporter}.`,
    ``,
    `Decide whether to:`,
    `  - Recore the cylinder (treats the loss as a security risk; invalidates every copy)`,
    `  - Cut a replacement only (treats the loss as low-risk)`,
    `  - Write off and retire the key`,
    comment,
    ``,
    `Open in Command Centre: ${link}`,
  ].join("\n").trim();
}

// ── Batch helpers for plannerSyncTimer's existence checks ───────────────────
// The timer used to issue one SELECT per (entity × trigger × leadTime) inside
// nested loops to look up an existing PlannerTasks row. These helpers let
// callers pre-fetch the relevant rows in a single query and look them up by
// composite key, collapsing N×M×K reads into one.

export interface PlannerTaskRowShape {
  EntityType: string;
  EntityId: number;
  TriggerType: string;
  LeadTimeDays: number;
  Id: number;
  PlannerTaskId: string;
  Status: string;
}

export interface PlannerTaskKey {
  entityType: "tenant" | "job";
  entityId: number;
  triggerType: TriggerType;
  leadTimeDays: number;
}

export function plannerTaskKey(k: PlannerTaskKey): string {
  return `${k.entityType}|${k.entityId}|${k.triggerType}|${k.leadTimeDays}`;
}

export function groupPlannerTasksByKey(
  rows: PlannerTaskRowShape[],
): Map<string, PlannerTaskRowShape> {
  const m = new Map<string, PlannerTaskRowShape>();
  for (const r of rows) {
    const k = `${r.EntityType}|${r.EntityId}|${r.TriggerType}|${r.LeadTimeDays}`;
    m.set(k, r); // last row wins; DB has a unique constraint so this is rare
  }
  return m;
}

/**
 * Which tenancies get lease tasks this run (PLAN D7, D21). A schedule nobody has
 * signed off is unverified, so its 90/60/30-day expiry, option and review tasks
 * are not raised, and any already open are removed: `removeFor` is the unsigned
 * tenancies that still have an active task.
 */
export function leaseTaskPlan(
  tenants: readonly PlannerTenantRow[],
  taskRows: readonly PlannerTaskRowShape[],
): { eligible: PlannerTenantRow[]; removeFor: number[] } {
  const withActiveTask = new Set(
    taskRows.filter((row) => row.Status === "active").map((row) => row.EntityId),
  );
  return {
    eligible: tenants.filter((tenant) => tenant.scheduleSignedOff),
    removeFor: tenants
      .filter((tenant) => !tenant.scheduleSignedOff && withActiveTask.has(tenant.tenantId))
      .map((tenant) => tenant.tenantId),
  };
}
