// Money-record rules shared by the quote, invoice, purchase-order and payment
// handlers (beta sprint J3, WP42b). Pure: each takes what the handler already
// loaded and says whether to refuse, with the code the ledger records, the
// sentence the person sees and the HTTP status.

export interface MoneyRefusal {
  code: string;
  message: string;
  status: 403 | 409 | 422;
}

export type MoneySubject = "quote" | "invoice" | "purchase_order";

const WORDS: Record<MoneySubject, string> = {
  invoice: "invoice",
  purchase_order: "purchase order",
  quote: "quote",
};

function refuse(code: string, message: string, status: MoneyRefusal["status"]): MoneyRefusal {
  return { code, message, status };
}

/**
 * The job a money record belongs to must accept money changes: internal jobs
 * have no quotes, POs or invoices; a done job is reopened first (J2's
 * reopenJob); an archived job is restored first.
 */
export function jobMoneyRefusal(job: { isArchived?: unknown; isInternal?: unknown; status?: unknown }): MoneyRefusal | null {
  if (job.isInternal === true || job.isInternal === 1) {
    return refuse("internal_job", "Internal jobs have no quotes, purchase orders or invoices.", 422);
  }
  if (job.status === "Done") {
    return refuse("job_done", "This job is done. A manager can reopen it before its quotes, purchase orders or invoices change.", 409);
  }
  if (job.isArchived === true || job.isArchived === 1) {
    return refuse("job_archived", "This job is archived. Restore it before its quotes, purchase orders or invoices change.", 409);
  }
  return null;
}

/**
 * An amount must be a number above $0. `required` is for creating a record;
 * on an edit, leaving the field out is no change, but clearing it is refused.
 */
export function amountRefusal(value: unknown, label: string, required: boolean): MoneyRefusal | null {
  if (value === undefined && !required) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return refuse("amount_invalid", `${label} is required and must be more than $0.`, 422);
  }
  return null;
}

function nameKey(name: unknown): string {
  return typeof name === "string" ? name.trim().toLowerCase() : "";
}

/** Two stored display names are the same person (names are all these tables keep). */
export function samePerson(left: unknown, right: unknown): boolean {
  const key = nameKey(left);
  return key !== "" && key === nameKey(right);
}

/** Whoever added a quote or invoice doesn't approve it; nor does a director approve a quote they added. */
export function creatorRefusal(createdBy: unknown, approver: string, subject: MoneySubject): MoneyRefusal | null {
  return samePerson(createdBy, approver)
    ? refuse("creator", `You added this ${WORDS[subject]}, so someone else has to approve it.`, 403)
    : null;
}

/** The director's approval comes from a different person than the first approval. */
export function stageOneRefusal(stageOneBy: unknown, director: string, subject: MoneySubject): MoneyRefusal | null {
  return samePerson(stageOneBy, director)
    ? refuse("same_approver", `You gave this ${WORDS[subject]} its first approval, so another director has to give the director approval.`, 403)
    : null;
}

/** Statuses a quote or invoice can be approved from: anything else is stale or already decided. */
const APPROVABLE = new Set(["pending", "awaiting_approval"]);

export function approvableRefusal(status: unknown, subject: MoneySubject): MoneyRefusal | null {
  if (typeof status === "string" && APPROVABLE.has(status)) return null;
  const now = typeof status === "string" && status !== "" ? status.replace(/_/g, " ") : "in another state";
  return refuse("not_approvable", `This ${WORDS[subject]} is ${now}, so it can't be approved now. Reload to see where it stands.`, 409);
}

/**
 * Beta sprint decision 4: admin approves, pays and marks in MYOB only on
 * records flagged as test data. Applies to a caller whose only working role
 * is admin; production gives each person one role.
 */
export function adminRefusal(roles: readonly string[], isTestRecord: boolean): MoneyRefusal | null {
  const keys = roles.map((role) => role.trim().toLowerCase());
  const adminOnly = keys.includes("admin") && keys.every((role) => role === "admin" || role === "user");
  return adminOnly && !isTestRecord
    ? refuse("admin_test_records_only", "Admin can do this on test records only.", 403)
    : null;
}

/** True when the caller holds admin (so the handler checks whether the record is test data). */
export function holdsAdmin(roles: readonly string[]): boolean {
  return roles.some((role) => role.trim().toLowerCase() === "admin");
}

/** A refusal as the HTTP answer: the code the ledger records and the sentence people see. */
export function refusalResponse(refusal: MoneyRefusal): { jsonBody: { code: string; error: string }; status: number } {
  return { jsonBody: { code: refusal.code, error: refusal.message }, status: refusal.status };
}
