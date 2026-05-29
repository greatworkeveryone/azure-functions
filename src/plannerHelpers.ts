export type TriggerType =
  | "lease_expiry"
  | "option_notice"
  | "rent_review"
  | "job_update_due"         // legacy — existing tasks only, routes to Facilities
  | "stalled_facilities"     // IsStalled=1 AND AwaitingRole != 'accounts'
  | "awaiting_accounts"      // AwaitingRole = 'accounts'
  | "director_approval"      // DirectorNeededCount > 0
  | "oncharge_pending"       // IsOnchargeable=1 AND no outgoing invoice yet
  | "lost_key_reported";     // key marked lost — pending facilities decision

export const LEAD_TIMES = [90, 60, 30] as const;
export type LeadTime = (typeof LEAD_TIMES)[number];

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

function subMonthsUTC(date: Date, months: number): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - months, date.getUTCDate()),
  );
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
    case "option_notice": {
      if (!tenant.expiry || tenant.optionNoticeMonths == null) return null;
      return subMonthsUTC(new Date(tenant.expiry), tenant.optionNoticeMonths);
    }
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
      const deadline =
        tenant.expiry && tenant.optionNoticeMonths != null
          ? formatDDMMYYYY(
              subMonthsUTC(
                new Date(tenant.expiry),
                tenant.optionNoticeMonths,
              ).toISOString(),
            )
          : "—";
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

export function buildStalledJobTaskDescription(
  job: PlannerStalledJobRow,
  appBaseUrl: string,
): string {
  const location = job.buildingName ?? "";
  const stalledDate = job.stalledAt ? formatDDMMYYYY(job.stalledAt.slice(0, 10)) : "—";
  return `${location ? location + "\n" : ""}Stalled since: ${stalledDate}\n${appBaseUrl}/jobs/${job.jobId}`;
}

export function buildAwaitingAccountsTaskDescription(
  job: PlannerAccountsJobRow,
  appBaseUrl: string,
): string {
  const location = job.buildingName ?? "";
  return `${location ? location + "\n" : ""}Awaiting accounts action\n${appBaseUrl}/jobs/${job.jobId}`;
}

export function buildDirectorApprovalTaskDescription(
  job: PlannerAccountsJobRow,
  appBaseUrl: string,
): string {
  const location = job.buildingName ?? "";
  return `${location ? location + "\n" : ""}Invoice or quote requires director sign-off\n${appBaseUrl}/jobs/${job.jobId}`;
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
  return `${location ? location + "\n" : ""}On-charge to tenant: ${amount}${notesLine}\n${appBaseUrl}/jobs/${job.jobId}`;
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
