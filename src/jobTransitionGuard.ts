// Job transition guard: who may move a job where, and only once the money
// says so. The state machine (jobStatusMachine.ts) says which edges exist;
// this says whether this person, with this job's quotes and invoices, may take
// one. Spend authority stops being a convention (JB1, jobs-flow N1–N4).
//
// One pure module, kept byte-for-byte identical in both repos:
//   rpcc-functions  src/jobTransitionGuard.ts          enforces
//   command-centre  src/helpers/jobTransitionGuard.ts  explains (menus, reasons)
// Both are tested from one shared vector file (jobTransitionGuard.vectors.json),
// and each repo pins the SHA-256 of this file and of the vectors.
//
// Pure: no imports, I/O, clock or environment. The caller passes the machine's
// answer for the request (machineTarget) and the job's facts.

export type GuardStatus = "New" | "Quote" | "Awaiting Approval" | "Work" | "Tenant" | "Done";
export type GuardSide = "facilities" | "accounts";

export interface GuardState {
  awaitingRole: GuardSide;
  status: GuardStatus;
}

/** What the guard needs to know about the job, read inside the decision's transaction. */
export interface GuardFacts {
  /** Every incoming invoice (not rejected) is paid in full. */
  allInvoicesPaid: boolean;
  /** Fully approved invoices (either direction) not yet marked created in MYOB. */
  approvedInvoicesNotInMyob: number;
  /** Jobs.ApprovedQuoteID points at a quote that is approved (or completed). */
  hasApprovedQuote: boolean;
  /** At least one purchase order on the job is marked work complete. */
  hasCompletePurchaseOrder: boolean;
  /** At least one quote that isn't rejected. */
  hasQuote: boolean;
  /** Incoming (contractor) invoices that aren't rejected. */
  incomingInvoices: number;
  /** Of those, how many are not yet fully approved. */
  incomingInvoicesAwaitingApproval: number;
  isContract: boolean;
  isInternal: boolean;
}

export type GuardActor = { kind: "user"; roles: readonly string[] } | { kind: "system" };

export type GuardRequest =
  /** A person picked a status (addJobEvent). */
  | { kind: "manual"; target: GuardStatus }
  /** A manager reopens a done job. */
  | { kind: "reopen"; reason: string }
  /** The MYOB read-back saw every invoice paid (INVOICE_PAID). Never a person. */
  | { kind: "invoices_paid" };

export interface GuardInput {
  actor: GuardActor;
  current: GuardState;
  facts: GuardFacts;
  /** The machine's answer: resolveManualTarget for "manual", nextState(INVOICE_PAID) for "invoices_paid"; unused for "reopen". null = no such edge. */
  machineTarget: GuardState | null;
  request: GuardRequest;
}

export type GuardRefusal =
  | "role_not_permitted"
  | "done_is_final"
  | "illegal"
  | "no_quote"
  | "quote_not_approved"
  | "work_not_complete"
  | "moves_on_its_own"
  | "invoice_missing"
  | "invoice_not_approved"
  | "invoice_not_in_myob"
  | "not_done"
  | "reason_required"
  | "system_only"
  | "invoices_not_paid";

export type GuardDecision = { allowed: true; to: GuardState } | { allowed: false; code: GuardRefusal; reason: string };

/** Roles that may move a job at all (the backend's job-edit roles, plus cfo). */
export const JOB_EDIT_ROLES: readonly string[] = Object.freeze([
  "facilities",
  "accounts",
  "facilities_manager",
  "accounts_manager",
  "cfo",
  "director",
  "admin",
]);

/** Roles that may reopen a done job. Admin is not one: reopening touches money records (decision 4). */
export const REOPEN_ROLES: readonly string[] = Object.freeze(["facilities_manager", "accounts_manager", "cfo", "director"]);

/** Roles that may set IsContract / IsInternal ("facilities_manager and above"). */
export const FLAG_ROLES: readonly string[] = Object.freeze(["facilities_manager", "accounts_manager", "cfo", "director", "admin"]);

const REASONS: Record<GuardRefusal, string> = {
  done_is_final: "This job is done. A manager can reopen it, with a reason.",
  illegal: "A job can't move there from where it is now.",
  invoice_missing: "A job is closed against an invoice: add the contractor's invoice first.",
  invoice_not_approved: "Every contractor invoice must be fully approved before the job is closed.",
  invoice_not_in_myob: "Every approved invoice must be marked as created in MYOB before the job is closed.",
  invoices_not_paid: "Not every invoice on this job is paid yet.",
  no_quote: "Add the quote before sending it for approval.",
  not_done: "Only a done job can be reopened.",
  work_not_complete:
    "A job goes to accounts once the work is marked complete on its purchase order, or, on a contract or internal job with no purchase order, once the contractor's invoice is added.",
  moves_on_its_own:
    "That move happens by itself when the quote, purchase order or invoice is saved. By hand you can only put a job on hold, resume it, start work on a contract job or close it.",
  quote_not_approved: "Work starts once a quote is approved (or on a contract or internal job).",
  reason_required: "Say why the job is being reopened.",
  role_not_permitted: "Your role can't make this change.",
  system_only: "Only the MYOB read-back can close a job as paid.",
};

function refuse(code: GuardRefusal): GuardDecision {
  return { allowed: false, code, reason: REASONS[code] };
}

function holds(actor: GuardActor, allowed: readonly string[]): boolean {
  return actor.kind === "user" && actor.roles.some((role) => allowed.includes(role.trim().toLowerCase()));
}

/** The work-completed fact: a purchase order marked complete, or, where no purchase order is needed, the contractor's invoice on record. */
function workIsComplete(facts: GuardFacts): boolean {
  return facts.hasCompletePurchaseOrder || ((facts.isContract || facts.isInternal) && facts.incomingInvoices >= 1);
}

function guardManual(input: GuardInput, target: GuardStatus): GuardDecision {
  const { actor, current, facts, machineTarget } = input;
  if (!holds(actor, JOB_EDIT_ROLES)) return refuse("role_not_permitted");
  if (current.status === "Done") return refuse("done_is_final");
  // Resuming from Tenant asks for Work but lands wherever the job was held.
  const resuming = current.status === "Tenant" && target === "Work";
  if (machineTarget === null || (!resuming && machineTarget.status !== target)) return refuse("illegal");
  if (machineTarget.status === "Awaiting Approval" && machineTarget.awaitingRole === "facilities" && !facts.hasQuote) {
    return refuse("no_quote");
  }
  if (machineTarget.status === "Work" && !(facts.hasApprovedQuote || facts.isContract || facts.isInternal)) {
    return refuse("quote_not_approved");
  }
  // The job reaches accounts because the work is done, never because someone
  // says so (S1-1). Resuming from a hold restores where the job already was.
  if (
    current.status !== "Tenant" &&
    machineTarget.status === "Awaiting Approval" &&
    machineTarget.awaitingRole === "accounts" &&
    !workIsComplete(facts)
  ) {
    return refuse("work_not_complete");
  }
  if (machineTarget.status === "Done" && !facts.isInternal) {
    if (facts.incomingInvoices < 1) return refuse("invoice_missing");
    if (facts.incomingInvoicesAwaitingApproval > 0) return refuse("invoice_not_approved");
    if (facts.approvedInvoicesNotInMyob > 0) return refuse("invoice_not_in_myob");
  }
  // JOB-09: every other move happens by itself when the record behind it is
  // saved. By hand a person only holds, resumes, starts a contract job, or closes.
  if (!isHandMove(current, target)) return refuse("moves_on_its_own");
  return { allowed: true, to: machineTarget };
}

/** Hold, resume, start work on a contract job (the machine offers it only for one), close. */
function isHandMove(current: GuardState, target: GuardStatus): boolean {
  if (target === "Tenant" || target === "Done") return true;
  return target === "Work" && (current.status === "Tenant" || current.status === "New");
}

function guardReopen(input: GuardInput, reason: string): GuardDecision {
  const { actor, current, facts } = input;
  if (!holds(actor, REOPEN_ROLES)) return refuse("role_not_permitted");
  if (current.status !== "Done") return refuse("not_done");
  if (typeof reason !== "string" || reason.trim() === "") return refuse("reason_required");
  const landing: GuardState = facts.isInternal
    ? { awaitingRole: "facilities", status: "Work" }
    : { awaitingRole: "accounts", status: "Awaiting Approval" };
  return { allowed: true, to: landing };
}

function guardInvoicesPaid(input: GuardInput): GuardDecision {
  const { actor, facts, machineTarget } = input;
  if (actor.kind !== "system") return refuse("system_only");
  if (machineTarget === null || machineTarget.status !== "Done") return refuse("illegal");
  if (facts.incomingInvoices < 1 || !facts.allInvoicesPaid) return refuse("invoices_not_paid");
  return { allowed: true, to: machineTarget };
}

/**
 * Decides one transition. Manual picks (a person, any job-edit role): never
 * out of Done; only along an edge the machine has (a resume lands where the
 * job was held, and that landing is checked like any other); and only the four
 * moves a person makes by hand (hold, resume, start work on a contract job,
 * close), since every other edge moves by itself when its record is saved; into (Awaiting Approval,
 * facilities) only with a quote; into (Awaiting Approval, accounts) only once
 * the work is complete (a purchase order marked complete, or an invoice on a
 * contract or internal job); into Work only with an approved quote, or on
 * a contract or internal job; into Done only when every contractor invoice is
 * fully approved and every approved invoice is marked in MYOB (internal jobs
 * excepted). Reopen: a manager, a done job and a reason; it lands back on
 * (Awaiting Approval, accounts), or (Work, facilities) for an internal job.
 * Invoices paid: the system only, every incoming invoice paid.
 */
export function guardTransition(input: GuardInput): GuardDecision {
  const { request } = input;
  if (request.kind === "manual") return guardManual(input, request.target);
  if (request.kind === "reopen") return guardReopen(input, request.reason);
  return guardInvoicesPaid(input);
}

/**
 * The manual picks the status chip and the progress note offer: hold (to
 * Tenant) from any live state, and resume (out of Tenant). Everything else
 * moves through the step that owns it (approve a quote, close the job, ...).
 */
export function isHoldOrResume(current: GuardState, target: GuardStatus): boolean {
  if (current.status === "Done") return false;
  if (target === "Tenant") return current.status !== "Tenant";
  return current.status === "Tenant" && target === "Work";
}

export type FlagRefusal = "role_not_permitted" | "flag_frozen";

/**
 * Whether IsContract / IsInternal may change: facilities_manager and above
 * only, and never once the job has a quote, purchase order or invoice (the
 * flag decides which money path the job takes). Null when allowed.
 */
export function flagChangeRefusal(input: { actor: GuardActor; hasMoneyRecords: boolean }): { code: FlagRefusal; reason: string } | null {
  if (!holds(input.actor, FLAG_ROLES)) {
    return { code: "role_not_permitted", reason: "Only a manager can mark a job as contract or internal." };
  }
  if (input.hasMoneyRecords) {
    return { code: "flag_frozen", reason: "This job already has a quote, purchase order or invoice, so contract and internal can't change." };
  }
  return null;
}
