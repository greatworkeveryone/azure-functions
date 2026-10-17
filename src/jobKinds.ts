// Job kinds (Jobs.Kind, migration 079) and which of them run the contractor and
// money flow. Mirrors JobKind in command-centre src/types/job.ts.
//
//   facilities   reactive works
//   maintenance  scheduled servicing
//   admin        Admin / Accounts decision jobs (plan D2): a question, a decision
//                and a next step, with no contractor, quote, PO or invoice
//
// Whatever chases, syncs or checks the contractor flow asks for the kinds it
// applies to by name (CONTRACTOR_FLOW_KINDS). Nothing asks "is this not admin",
// so a kind added later gets none of that flow until someone lists it on purpose.

export const JOB_KINDS = ["facilities", "maintenance", "admin"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const ADMIN_KIND: JobKind = "admin";

/** The kinds that run the contractor and money flow: quote requests, quotes, POs,
 *  invoices, the escalation policies that chase the work and them, Planner tasks,
 *  digest lines and defects-liability checks. */
export const CONTRACTOR_FLOW_KINDS: readonly string[] = ["facilities", "maintenance"];

/** A job's kind as stored. A missing or blank one reads as facilities, like the
 *  column's default and the frontend. */
export function jobKindOf(value: unknown): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : "facilities";
}

export function runsContractorFlow(kind: unknown): boolean {
  return CONTRACTOR_FLOW_KINDS.includes(jobKindOf(kind));
}
