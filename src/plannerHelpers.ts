export type TriggerType =
  | "lease_expiry"
  | "option_notice"
  | "rent_review"
  | "job_update_due";

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
  const link = `${appBaseUrl}/tenancy/${tenant.tenantId}`;

  switch (triggerType) {
    case "lease_expiry":
      return `${location}\nExpiry: ${tenant.expiry ? formatDDMMYYYY(tenant.expiry) : "—"}\n${link}`;
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
      return `${location}\nOption deadline: ${deadline}\nLease expiry: ${tenant.expiry ? formatDDMMYYYY(tenant.expiry) : "—"}\n${link}`;
    }
    case "rent_review":
      return `${location}\nReview due: ${tenant.nextReviewDate ? formatDDMMYYYY(tenant.nextReviewDate) : "—"}\nReview type: ${tenant.reviewType ?? "—"}\n${link}`;
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

export function toIsoDateString(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
