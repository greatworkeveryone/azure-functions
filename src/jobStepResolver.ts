// Job step resolver: which of the eight steps a job is at, what happens next, and who it is waiting on, from the
// job's records. Every screen that says where a job stands reads this one answer (audit §4.5): the job header, the
// step nav, the Job Board, Overview, My work and the digest. The stored statuses are unchanged; this is derived.
//
// One pure module, kept byte-for-byte identical in both repos (with jobStepPresent.ts, the vectors and the test body):
//   rpcc-functions  src/jobStepResolver.ts          computes it on getJob and every job list
//   command-centre  src/helpers/jobStepResolver.ts  renders it, and recomputes it for optimistic updates and mock mode
//
// Pure: type-only imports, no I/O, clock or environment. Facts are counts and flags read from the job's quotes,
// purchase orders and invoices, never amounts or the stored status alone. The viewer is not an input here:
// jobStepPresent.ts turns this answer into what one person sees.

import { JOB_STEP_LABELS, stepNumber, type JobStep, type JobStepKey, type NextAction, type StepFacts } from "./jobStepTypes";

export type { JobStep, JobStepKey, NextAction, StepFacts } from "./jobStepTypes";
export { JOB_STEP_LABELS, JOB_STEP_ORDER } from "./jobStepTypes";

const DIRECTOR = "a director";
const QUOTE_APPROVERS = "a facilities manager or accounts";
const INVOICE_APPROVERS = "accounts";

type Draft = Partial<NextAction> & Pick<NextAction, "reason" | "task" | "verb" | "who">;

function action(draft: Draft): NextAction {
  return {
    action: null,
    capability: null,
    creator: null,
    escalation: null,
    externalWait: null,
    jumpTarget: null,
    person: false,
    unassigned: false,
    waitingOnRole: null,
    waitingOnUserId: null,
    ...draft,
  };
}

/** The person the job is with: its assignee, else Facilities with "unassigned" said plainly. */
function officer(facts: StepFacts): Pick<NextAction, "person" | "unassigned" | "waitingOnUserId" | "who"> {
  const name = facts.assignee.name?.trim();
  return name
    ? { person: true, unassigned: false, waitingOnUserId: facts.assignee.userId, who: name }
    : { person: false, unassigned: true, waitingOnUserId: null, who: "Facilities" };
}

function result(key: JobStepKey, next: NextAction): { nextAction: NextAction; step: JobStep } {
  return { nextAction: next, step: { key, label: JOB_STEP_LABELS[key], number: stepNumber(key) } };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function quoteRound(facts: StepFacts) {
  const { contractorsRequested, declined, requestsSent } = facts.quotes;
  const who = officer(facts);
  // Every quote declined (JOB-03): the round starts again, whatever was sent before.
  if (contractorsRequested === 0 || declined > 0) {
    const reason = declined > 0
      ? "Every quote was declined. Ask more contractors, or add a quote you already have."
      : "Pick the contractors to ask for a quote. Floorplan prepares the email; you send it from your own mailbox.";
    return result("request_quotes", action({ ...who, capability: "createQuote", jumpTarget: "quotes", reason, task: "request quotes", verb: "Request quotes" }));
  }
  if (requestsSent === 0) {
    return result("request_quotes", action({
      ...who,
      capability: "createQuote",
      jumpTarget: "quotes",
      reason: `${plural(contractorsRequested, "contractor")} to ask. Send the request from your own mailbox, then mark it sent.`,
      task: "send the quote request",
      verb: "Prepare quote request",
    }));
  }
  return result("request_quotes", action({
    ...who,
    capability: "createQuote",
    externalWait: plural(requestsSent, "contractor"),
    jumpTarget: "quotes",
    reason: `${requestsSent} of ${contractorsRequested} contractors have the request. Replies come to your mailbox. Add each quote here when it arrives.`,
    task: "add the received quote",
    verb: "Add received quote",
  }));
}

function quoteApproval(facts: StepFacts) {
  const { quotes } = facts;
  if (quotes.awaitingDirector > 0) {
    return result("choose_quote", action({
      capability: "approveQuoteAsDirector",
      creator: quotes.pendingCreator,
      jumpTarget: "quotes",
      reason: "With a director for approval. Work starts once the quote is approved.",
      task: "approve the quote",
      verb: "Approve quote",
      who: DIRECTOR,
    }));
  }
  if (quotes.pendingNeedsDirector) {
    return result("choose_quote", action({
      capability: "approveQuoteAsDirector",
      creator: quotes.pendingCreator,
      escalation: {
        capability: "approveQuote",
        jumpTarget: "quotes",
        reason: "This quote needs a director's approval. Send it to the directors from the quote.",
        verb: "Send to director",
      },
      jumpTarget: "quotes",
      reason: "This quote needs a director's approval. Anyone who can approve quotes can send it to the directors.",
      task: "approve the quote",
      verb: "Approve quote",
      who: DIRECTOR,
    }));
  }
  return result("choose_quote", action({
    capability: "approveQuote",
    creator: quotes.pendingCreator,
    jumpTarget: "quotes",
    reason: "Choose a quote to approve. Work starts once one is approved.",
    task: "approve the quote",
    verb: "Approve quote",
    person: quotes.approver?.userId != null,
    waitingOnUserId: quotes.approver?.userId ?? null,
    who: quotes.approver?.name ?? QUOTE_APPROVERS,
  }));
}

function purchaseOrderStep(facts: StepFacts) {
  const { purchaseOrders } = facts;
  if (purchaseOrders.raised === 0) {
    if (facts.kind === "contract") {
      return result("work_under_way", action({
        ...officer(facts),
        capability: "createInvoice",
        jumpTarget: "invoices",
        reason: "Adding the contractor's invoice marks the work complete on a contract job with no purchase order.",
        task: "add the contractor's invoice",
        verb: "Add the invoice",
      }));
    }
    return result("raise_po", action({
      capability: "createPurchaseOrder",
      jumpTarget: "po",
      reason: "The quote is approved. A facilities manager raises the purchase order so the contractor can start.",
      task: "raise the purchase order",
      verb: "Raise purchase order",
      waitingOnRole: "facilities_manager",
      who: "a facilities manager",
    }));
  }
  return result("work_under_way", action({
    ...officer(facts),
    capability: "completePurchaseOrder",
    jumpTarget: "po",
    reason: "The purchase order is raised. Mark the work complete on it when the contractor finishes; the job then goes to accounts.",
    task: "mark the work complete",
    verb: "Mark work complete",
  }));
}

function invoiceChain(facts: StepFacts) {
  const { invoices, purchaseOrders } = facts;
  if (invoices.incoming === 0) {
    const rejected = invoices.rejected > 0;
    return result("get_invoice", action({
      capability: "createInvoice",
      jumpTarget: "invoices",
      reason: rejected
        ? "The contractor's invoice was rejected. Add the corrected invoice."
        : "The work is complete. Add the contractor's invoice when it arrives.",
      task: rejected ? "add the corrected invoice" : "add the contractor's invoice",
      verb: rejected ? "Add corrected invoice" : "Add the invoice",
      who: "Accounts",
    }));
  }
  if (invoices.pending > 0) {
    return result("approve_invoice", action({
      capability: "approveInvoice",
      creator: invoices.pendingCreator,
      jumpTarget: "invoices",
      reason: invoices.pendingNeedsDirector
        ? "The invoice is waiting for approval. A director signs it off after the first approval."
        : "The invoice is waiting for approval.",
      task: "approve the invoice",
      verb: "Approve invoice",
      person: invoices.approver?.userId != null,
      waitingOnUserId: invoices.approver?.userId ?? null,
      who: invoices.approver?.name ?? INVOICE_APPROVERS,
    }));
  }
  if (invoices.awaitingDirector > 0) {
    return result("approve_invoice", action({
      capability: "approveInvoiceAsDirector",
      jumpTarget: "invoices",
      reason: "The invoice has its first approval and is with a director.",
      task: "approve the invoice",
      verb: "Approve as director",
      who: DIRECTOR,
    }));
  }
  if (invoices.approvedNotInMyob > 0) {
    return result("record_myob", action({
      capability: "markInvoiceInMyob",
      jumpTarget: "invoices",
      reason: purchaseOrders.notInMyob > 0
        ? "The invoice is approved. An accounts manager records it in MYOB; the purchase order needs recording too before the job closes."
        : "The invoice is approved. An accounts manager records it in MYOB, then the job can close.",
      task: "record the invoice in MYOB",
      verb: "Record invoice in MYOB",
      who: "an accounts manager",
    }));
  }
  if (purchaseOrders.notInMyob > 0) {
    return result("record_myob", action({
      capability: "markPurchaseOrderInMyob",
      jumpTarget: "po",
      reason: "The invoice is recorded. A manager records the purchase order in MYOB, then the job can close.",
      task: "record the purchase order in MYOB",
      verb: "Record purchase order in MYOB",
      who: "a manager",
    }));
  }
  return result("record_myob", action({
    action: "closeJob",
    capability: "editJobs",
    reason: "Everything is recorded in MYOB. Closing the job finishes it.",
    task: "close the job",
    verb: "Close job",
    who: "Accounts",
  }));
}

/** The step a job is at and what happens next, from its records. Pure and deterministic. */
export function resolveJobStep(facts: StepFacts): { nextAction: NextAction; step: JobStep } {
  const { kind, status } = facts;

  if (status === "Done") {
    return result("closed", action({
      action: "downloadPacket",
      reason: "The job is closed. The job packet has everything on it.",
      task: "download the job packet",
      verb: "Download job packet",
      who: "Nobody",
    }));
  }

  if (status === "Tenant") {
    return result("on_hold", action({
      ...officer(facts),
      action: "unblock",
      capability: "editJobs",
      reason: "The job is on hold. Unblock it to carry on from where it stopped.",
      task: "unblock the job",
      verb: "Unblock job",
    }));
  }

  if (kind === "internal") {
    return result("work_under_way", action({
      ...officer(facts),
      capability: "editJobs",
      jumpTarget: "done",
      reason: "Internal job: no quotes, purchase orders or invoices. Close it when the work is finished.",
      task: "finish the job",
      verb: "Close job",
    }));
  }

  if (kind === "contract" && status === "New") {
    return result("work_under_way", action({
      ...officer(facts),
      action: "startWork",
      capability: "editJobs",
      reason: "A contract job needs no quotes. Start work to carry on.",
      task: "start the work",
      verb: "Start work",
    }));
  }

  if (status === "Awaiting Approval" && facts.awaitingRole === "accounts") return invoiceChain(facts);

  if (kind !== "contract") {
    const { quotes } = facts;
    const received = quotes.pending + quotes.awaitingApproval + quotes.awaitingDirector;
    if (!quotes.approved && (received > 0 || status === "Awaiting Approval")) {
      return received > 0 ? quoteApproval(facts) : quoteRound(facts);
    }
    if (!quotes.approved && (status === "New" || status === "Quote")) return quoteRound(facts);
  }

  // Work, or a quoted job whose quote is approved but whose status has not yet moved: the purchase order step.
  // A job still at Work whose purchase order is already complete is on its way to accounts: read the invoice side.
  if (status === "Work" && facts.purchaseOrders.complete > 0) return invoiceChain(facts);
  return purchaseOrderStep(facts);
}
