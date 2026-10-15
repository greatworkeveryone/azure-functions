import { AppRole } from "../auth";

// Who may read the Decision history of a subject: whoever may already read that
// subject through its own endpoint. Each list is copied from the endpoint named
// beside it and must change with it. requireRole's hierarchy still applies on
// top: admin passes every check, director any non-admin one, and the manager
// roles pass their team's check.
//
// A subject with no entry here has no read endpoint of its own yet (billing
// runs, escalations, communications, role and limit changes, ...). Its history
// is director-only until the package that owns it adds a line below.

// getJob: VIEW_JOBS_ROLES in functions/jobs.ts
const JOB_READ = [
  AppRole.ADMIN,
  AppRole.DIRECTOR,
  AppRole.FACILITIES,
  AppRole.FACILITIES_APPROVAL,
  AppRole.ACCOUNTS,
  AppRole.ACCOUNTS_APPROVAL,
] as const;

// getRegisterTenant in functions/tenancy.ts; getRentReview and getRentReviews share it (rentReview/http.ts)
const TENANCY_READ = [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR] as const;

// getQuotes in functions/quotes.ts
const QUOTE_READ = [
  AppRole.ACCOUNTS,
  AppRole.ACCOUNTS_APPROVAL,
  AppRole.FACILITIES,
  AppRole.FACILITIES_APPROVAL,
  AppRole.DIRECTOR,
] as const;

// getInvoices / getJobInvoices in functions/invoices.ts, getPurchaseOrders in functions/purchaseOrders.ts
const INVOICE_AND_PO_READ = [AppRole.ACCOUNTS, AppRole.DIRECTOR, AppRole.FACILITIES] as const;

// getPayments in functions/payments.ts
const PAYMENT_READ = [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.DIRECTOR] as const;

const DEFAULT_READ = [AppRole.DIRECTOR] as const;

// A Map, not an object: subjectType comes from the query string and a plain
// object would answer "constructor" with Object.prototype's function.
const HISTORY_READ_ROLES = new Map<string, readonly AppRole[]>([
  ["invoice", INVOICE_AND_PO_READ],
  ["job", JOB_READ],
  ["payment", PAYMENT_READ],
  ["purchase_order", INVOICE_AND_PO_READ],
  ["quote", QUOTE_READ],
  // A review is read through getRentReview, which has the tenancy's own gate.
  ["rent_review", TENANCY_READ],
  ["tenancy", TENANCY_READ],
]);

export function historyReadRoles(subjectType: string): readonly AppRole[] {
  return HISTORY_READ_ROLES.get(subjectType) ?? DEFAULT_READ;
}
