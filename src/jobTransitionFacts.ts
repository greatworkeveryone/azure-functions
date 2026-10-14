// DB-facing half of the job transition guard (jobTransitionGuard.ts): reads a
// job and the facts its next move depends on, inside the caller's transaction,
// with the job row locked until commit. The guard decides on exactly what this
// returns, and the write that follows is predicated on the same state.

import { TYPES, type Connection } from "tedious";
import { decideAuthority, type AuthorityFacts } from "./approvalAuthority";
import { loadApprovalFacts } from "./approvalAuthority-db";
import { executeQuery, type SqlRow } from "./db";
import type { GuardFacts, GuardSide, GuardState, GuardStatus } from "./jobTransitionGuard";

export interface LockedJob {
  buildingId: number | null;
  current: GuardState;
  facts: GuardFacts;
  /** Quote, PO or invoice rows exist (freezes IsContract / IsInternal). */
  hasMoneyRecords: boolean;
  preBlock: GuardState | null;
}

/** Statuses that take an invoice out of the reckoning. */
const SET_ASIDE = new Set(["rejected", "superseded"]);

const toCents = (amount: number): number => Math.round(amount * 100);

/**
 * Invoice rows → the guard's invoice facts. Fully approved: director_approved,
 * or approved where the director gate (approval-authority core) does not apply
 * to its amount. Paid: payments marked paid cover the amount.
 */
export function summariseInvoices(
  rows: readonly SqlRow[],
  approval: AuthorityFacts,
): Pick<GuardFacts, "allInvoicesPaid" | "approvedInvoicesNotInMyob" | "incomingInvoices" | "incomingInvoicesAwaitingApproval"> {
  let incoming = 0;
  let awaiting = 0;
  let notInMyob = 0;
  let allPaid = true;
  for (const row of rows) {
    const status = typeof row.Status === "string" ? row.Status : "pending";
    if (SET_ASIDE.has(status)) continue;
    const amount = row.Amount == null ? Number.NaN : Number(row.Amount);
    const directorRequired = decideAuthority({ amount, buildingId: 0, subject: "invoice" }, approval).directorRequired;
    const fullyApproved = status === "director_approved" || (status === "approved" && !directorRequired);
    if (fullyApproved && row.MyobCreatedAt == null) notInMyob += 1;
    if (((row.Direction as string | null) ?? "incoming") !== "incoming") continue;
    incoming += 1;
    if (!fullyApproved) awaiting += 1;
    const paid = Number(row.PaidAmount ?? 0);
    if (!(Number.isFinite(amount) && amount > 0 && toCents(paid) >= toCents(amount))) allPaid = false;
  }
  return {
    allInvoicesPaid: incoming > 0 && allPaid,
    approvedInvoicesNotInMyob: notInMyob,
    incomingInvoices: incoming,
    incomingInvoicesAwaitingApproval: awaiting,
  };
}

function stateOf(status: unknown, awaitingRole: unknown): GuardState {
  return { awaitingRole: ((awaitingRole as GuardSide | null) ?? "facilities"), status: status as GuardStatus };
}

/** The job, locked until the caller's transaction ends, and its guard facts. Null when there is no such job. */
export async function loadJobForTransition(connection: Connection, jobId: number): Promise<LockedJob | null> {
  const jobRows = await executeQuery(
    connection,
    `SELECT j.Status, j.AwaitingRole, j.PreBlockStatus, j.PreBlockAwaitingRole, j.IsContract, j.IsInternal, j.BuildingID,
            CASE WHEN EXISTS (SELECT 1 FROM Quotes q WHERE q.JobID = j.JobID AND q.Status <> 'rejected') THEN 1 ELSE 0 END AS HasQuote,
            CASE WHEN EXISTS (SELECT 1 FROM Quotes q WHERE q.QuoteID = j.ApprovedQuoteID AND q.Status IN ('approved', 'completed')) THEN 1 ELSE 0 END AS HasApprovedQuote,
            CASE WHEN EXISTS (SELECT 1 FROM Quotes q WHERE q.JobID = j.JobID)
                   OR EXISTS (SELECT 1 FROM PurchaseOrders p WHERE p.JobID = j.JobID)
                   OR EXISTS (SELECT 1 FROM JobInvoices i WHERE i.JobID = j.JobID) THEN 1 ELSE 0 END AS HasMoneyRecords
       FROM Jobs j WITH (UPDLOCK, HOLDLOCK)
      WHERE j.JobID = @JobID`,
    [{ name: "JobID", type: TYPES.Int, value: jobId }],
  );
  if (jobRows.length === 0) return null;
  const job = jobRows[0];
  const invoiceRows = await executeQuery(
    connection,
    `SELECT i.Direction, i.Status, i.Amount, i.MyobCreatedAt,
            ISNULL((SELECT SUM(p.Amount) FROM Payments p WHERE p.JobInvoiceID = i.JobInvoiceID AND p.Status = 'paid'), 0) AS PaidAmount
       FROM JobInvoices i
      WHERE i.JobID = @JobID`,
    [{ name: "JobID", type: TYPES.Int, value: jobId }],
  );
  const buildingId = (job.BuildingID as number | null | undefined) ?? null;
  const approval = await loadApprovalFacts(connection, buildingId);
  return {
    buildingId,
    current: stateOf(job.Status, job.AwaitingRole),
    facts: {
      ...summariseInvoices(invoiceRows, approval),
      hasApprovedQuote: Boolean(job.HasApprovedQuote),
      hasQuote: Boolean(job.HasQuote),
      isContract: Boolean(job.IsContract),
      isInternal: Boolean(job.IsInternal),
    },
    hasMoneyRecords: Boolean(job.HasMoneyRecords),
    preBlock: job.PreBlockStatus == null ? null : stateOf(job.PreBlockStatus, job.PreBlockAwaitingRole),
  };
}
