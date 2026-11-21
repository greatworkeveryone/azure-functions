// The shapes of the job step resolver: the facts it reads, the step and next action it answers with. Byte-identical in
// both repos with jobStepResolver.ts (see the header there). Types and the eight step names only; no rules.

export type StepStatus = "New" | "Quote" | "Awaiting Approval" | "Work" | "Tenant" | "Done";
export type StepSide = "facilities" | "accounts";
export type StepJobKind = "standard" | "contract" | "internal";

/** The eight steps people see, in order, plus On hold (a job parked as Tenant). */
export type JobStepKey =
  | "request_quotes"
  | "choose_quote"
  | "raise_po"
  | "work_under_way"
  | "get_invoice"
  | "approve_invoice"
  | "record_myob"
  | "closed"
  | "on_hold";

export const JOB_STEP_ORDER: readonly Exclude<JobStepKey, "on_hold">[] = Object.freeze([
  "request_quotes",
  "choose_quote",
  "raise_po",
  "work_under_way",
  "get_invoice",
  "approve_invoice",
  "record_myob",
  "closed",
]);

export const JOB_STEP_LABELS: Readonly<Record<JobStepKey, string>> = Object.freeze({
  approve_invoice: "Approve the invoice",
  choose_quote: "Choose a quote",
  closed: "Closed",
  get_invoice: "Get the invoice",
  on_hold: "On hold",
  raise_po: "Raise purchase order",
  record_myob: "Record in MYOB",
  request_quotes: "Request quotes",
  work_under_way: "Work under way",
});

/** 1 to 8 for the eight steps; null while on hold (the job is parked, not at a step). */
export function stepNumber(key: JobStepKey): number | null {
  const index = JOB_STEP_ORDER.findIndex((step) => step === key);
  return index < 0 ? null : index + 1;
}

export interface JobStep {
  key: JobStepKey;
  label: string;
  /** Position out of eight, or null while on hold. */
  number: number | null;
}

/** The modal step a next action opens: the purchase order's own step is where work is completed. */
export type StepJumpTarget = "detail" | "quotes" | "po" | "invoices" | "done";

/** A direct action the button performs with no step to open. */
export type StepDirectAction = "closeJob" | "downloadPacket" | "startWork" | "unblock";

/** Who added the record a next action waits on approving (separation of duties: they cannot approve it). */
export interface StepActor {
  name: string | null;
  oid: string | null;
}

/** The person or role an approval routes to: a role phrase ("an accounts manager") or a named person. */
export interface StepApprover {
  name: string | null;
  userId: number | null;
}

export interface NextAction {
  action: StepDirectAction | null;
  /** The exact action-roles key the control needs; null when anyone may press it (the packet download). */
  capability: string | null;
  creator: StepActor | null;
  /** What someone who lacks `capability` but holds this one may do instead ("Send to director"). */
  escalation: { capability: string; jumpTarget: StepJumpTarget | null; reason: string; verb: string } | null;
  /** Set while the job is waiting on people outside Floorplan ("2 contractors"): the turn is not the viewer's. */
  externalWait: string | null;
  jumpTarget: StepJumpTarget | null;
  /** `who` names one person (not a team). */
  person: boolean;
  reason: string;
  /** The passive form: "approve the invoice", read as "Waiting on a director to approve the invoice". */
  task: string;
  /** True when the job has no assignee and `who` is a team. */
  unassigned: boolean;
  /** The button label. */
  verb: string;
  waitingOnUserId: number | null;
  /** A named person (the assignee, a named approver) or a team ("Facilities", "Accounts", "a director"). */
  who: string;
}

export interface QuoteFacts {
  /** Jobs.ApprovedQuoteID points at an approved (or completed) quote. */
  approved: boolean;
  /** Who a quote waiting for approval routes to, when known. */
  approver: StepApprover | null;
  /** Quotes sent up to a senior approver (awaiting_approval). */
  awaitingApproval: number;
  /** Quotes with a director (awaiting_director). */
  awaitingDirector: number;
  /** Contractors asked for a quote on this job. */
  contractorsRequested: number;
  /** Rejected quotes. */
  declined: number;
  /** Received and not yet decided (pending). */
  pending: number;
  pendingCreator: StepActor | null;
  /** The quote waiting for approval is over the line a director has to sign. */
  pendingNeedsDirector: boolean;
  /** Of the contractors asked, how many have had the request sent. */
  requestsSent: number;
}

export interface InvoiceFacts {
  /** Fully approved invoices (either direction) not yet marked created in MYOB. */
  approvedNotInMyob: number;
  approver: StepApprover | null;
  /** First approval done, director's still to come (approved, director required). */
  awaitingDirector: number;
  /** Incoming invoices that are not rejected or superseded. */
  incoming: number;
  /** Incoming invoices waiting for the first approval (pending or awaiting_approval). */
  pending: number;
  pendingCreator: StepActor | null;
  pendingNeedsDirector: boolean;
  /** Incoming invoices rejected and not replaced. */
  rejected: number;
}

export interface PurchaseOrderFacts {
  /** Marked work complete. */
  complete: number;
  /** Not yet marked as recorded in MYOB (a purchase order is never archived: there is no archive). */
  notInMyob: number;
  raised: number;
}

/** What the resolver reads about a job. The job is on hold when its status is Tenant. */
export interface StepFacts {
  assignee: { name: string | null; userId: number | null };
  awaitingRole: StepSide;
  invoices: InvoiceFacts;
  kind: StepJobKind;
  purchaseOrders: PurchaseOrderFacts;
  quotes: QuoteFacts;
  status: StepStatus;
}
