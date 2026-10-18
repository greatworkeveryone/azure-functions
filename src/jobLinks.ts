// Where a link into a job lands (beta sprint J6). Every director packet, Planner
// task, digest line and escalation email that points at a job names the step its
// reader acts on, so the job opens there and not on Detail. The app has no
// /jobs/:id path: ?jobId= opens the job and &step= the tab. The record's id rides
// along (quoteId, invoiceId…) so the link says which record it is about; the
// frontend opens the step and does not yet select the record. The frontend
// reads the same names (FE helpers/jobDeepLink.ts); change them in both repos.
//
// Leave this module import-free: plannerHelpers, the digest and the escalation
// adapters all load it.

export type JobLinkStep = "decision" | "invoices" | "po" | "quotes";

export interface JobLinkTarget {
  decisionRequestId?: number | null;
  invoiceId?: number | null;
  poId?: number | null;
  quoteId?: number | null;
  step?: JobLinkStep | null;
}

const RECORD_PARAMS = ["quoteId", "poId", "invoiceId", "decisionRequestId"] as const;

/** The in-app path, e.g. "/jobs?jobId=12&step=quotes&quoteId=3". A decision
 *  also carries "#decision", the anchor the job's decision section scrolls to
 *  (FE helpers/decisionEscalation.ts decisionPath). */
export function jobPath(jobId: number | string, target: JobLinkTarget = {}): string {
  const params = new URLSearchParams({ jobId: String(jobId) });
  if (target.step) params.set("step", target.step);
  for (const key of RECORD_PARAMS) {
    const id = target[key];
    if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) params.set(key, String(id));
  }
  return `/jobs?${params.toString()}${target.step === "decision" ? "#decision" : ""}`;
}

/** The full link from a base URL (APP_BASE_URL); a trailing slash or stray space is ignored. */
export function jobUrl(baseUrl: string, jobId: number | string, target: JobLinkTarget = {}): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}${jobPath(jobId, target)}`;
}

/** The step a quote or invoice is acted on in. */
export function stepForSubject(subject: "invoice" | "purchase_order" | "quote"): JobLinkStep {
  if (subject === "quote") return "quotes";
  return subject === "invoice" ? "invoices" : "po";
}
