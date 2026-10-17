// INVOICE_PAID (beta sprint J2): the system edge that closes a job once every
// invoice on it is paid. Raised only by the MYOB read-back (M10), never by a
// person; the transition guard refuses anyone else. The caller owns the
// transaction, as for ledger record(): the move, its event and its ledger row
// commit or roll back with the caller's own writes.

import type { Connection } from "tedious";
import { todayInDarwin } from "./darwinDate";
import { advanceJobStatus } from "./jobStatusHelpers";
import { JobEvent, nextState, type AwaitingRole, type JobStatus } from "./jobStatusMachine";
import { guardTransition, type GuardRefusal } from "./jobTransitionGuard";
import { loadJobForTransition } from "./jobTransitionFacts";
import { record } from "./ledger";
import { jobScope } from "./ledger/moneyDecisions";

export interface InvoicePaid {
  invoiceId: number;
  paidAt: Date;
}

function ddmmyyyy(instant: Date): string {
  const [year, month, day] = todayInDarwin(instant).split("-");
  return `${day}/${month}/${year}`;
}

/**
 * Moves the job to Done when the guard agrees (system actor, job waiting on
 * accounts, every incoming invoice paid in full by payments marked paid),
 * with an event and a job.invoices_paid ledger row naming the system process
 * and the paid timestamps. Otherwise changes nothing and says why.
 */
export async function closeJobWhenInvoicesPaid(
  connection: Connection,
  jobId: number,
  input: { paid: readonly InvoicePaid[]; source: string },
): Promise<{ closed: true } | { closed: false; code: GuardRefusal | "not_found" }> {
  const locked = await loadJobForTransition(connection, jobId);
  if (!locked) return { closed: false, code: "not_found" };
  const target = nextState(
    { awaitingRole: locked.current.awaitingRole as AwaitingRole, status: locked.current.status as JobStatus },
    JobEvent.INVOICE_PAID,
  );
  const decision = guardTransition({
    actor: { kind: "system" },
    current: locked.current,
    facts: locked.facts,
    machineTarget: target,
    request: { kind: "invoices_paid" },
  });
  if (!decision.allowed) return { closed: false, code: decision.code };

  const when = input.paid.map((entry) => `invoice ${entry.invoiceId} paid ${ddmmyyyy(entry.paidAt)}`).join(", ");
  const moved = await advanceJobStatus(connection, jobId, JobEvent.INVOICE_PAID, {
    actor: `System (${input.source})`,
    note: `All invoices paid (${when}) — job done.`,
  });
  if (!moved.advanced) return { closed: false, code: "illegal" };

  const scope = await jobScope(connection, jobId);
  await record(connection, {
    action: "job.invoices_paid",
    actor: { kind: "system", name: input.source },
    after: { paid: input.paid.map((entry) => ({ invoiceId: entry.invoiceId, paidAt: entry.paidAt.toISOString() })), status: "Done" },
    before: { awaitingRole: locked.current.awaitingRole, status: locked.current.status },
    buildingId: scope.buildingId,
    jobId: scope.jobId,
    ruleApplied: "all_invoices_paid",
    subject: { id: jobId, type: "job" },
  });
  return { closed: true };
}
