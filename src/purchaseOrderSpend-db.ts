// DB half of purchaseOrderSpend.ts: loads what the rule decides on (the job's
// other purchase orders, the approved quote's contractor, the approval facts)
// inside the caller's connection. Sequential on purpose: tedious runs one
// request per connection.

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import type { Identity } from "./approvalAuthority";
import { loadApprovalFacts } from "./approvalAuthority-db";
import { executeQuery } from "./db";
import type { MoneyJob } from "./moneyJob-db";
import type { MoneyRefusal } from "./moneyRules";
import { approvedQuoteOf } from "./moneyVariance-db";
import { committedTotal, purchaseOrderSpendRefusal, type PoSpendStage } from "./purchaseOrderSpend";

/** A purchase order's amount for spend: the cap, else the estimate; null when neither is known. */
export function spendAmount(row: { CostNotToExceed?: unknown; EstimatedCost?: unknown }): number | null {
  const raw = row.CostNotToExceed ?? row.EstimatedCost;
  return raw === null || raw === undefined ? null : Number(raw);
}

/** What the job's purchase orders (other than `excludeId`) add up to. Archived does not exist for purchase orders: every one counts. */
export async function otherPurchaseOrdersTotal(connection: Connection, jobId: number, excludeId: number | null): Promise<number> {
  const rows = await executeQuery(
    connection,
    `SELECT ISNULL(SUM(ISNULL(CostNotToExceed, EstimatedCost)), 0) AS Committed
       FROM PurchaseOrders
      WHERE JobID = @JobID AND (@ExcludeID IS NULL OR PurchaseOrderID <> @ExcludeID)`,
    [
      { name: "JobID", type: TYPES.Int, value: jobId },
      { name: "ExcludeID", type: TYPES.Int, value: excludeId },
    ],
  );
  return Number(rows[0]?.Committed ?? 0);
}

async function approvedQuoteContractor(connection: Connection, jobId: number): Promise<number | null> {
  const rows = await executeQuery(
    connection,
    "SELECT q.ContractorID FROM Jobs j INNER JOIN Quotes q ON q.QuoteID = j.ApprovedQuoteID WHERE j.JobID = @JobID",
    [{ name: "JobID", type: TYPES.Int, value: jobId }],
  );
  const id = rows[0]?.ContractorID;
  return typeof id === "number" ? id : null;
}

export interface PoSpendCheck {
  /** Everything the job's purchase orders reach with this one; what the quote variance is measured on. */
  committedAfter: number | null;
  otherCommitted: number;
  refusal: MoneyRefusal | null;
}

export async function checkPurchaseOrderSpend(
  connection: Connection,
  input: {
    actor: Identity;
    excludePurchaseOrderId: number | null;
    isTest: boolean;
    job: MoneyJob;
    poContractorId: number | null;
    stage: PoSpendStage;
    thisAmount: number | null;
  },
): Promise<PoSpendCheck> {
  const otherCommitted = await otherPurchaseOrdersTotal(connection, input.job.jobId, input.excludePurchaseOrderId);
  const quote = input.job.hasApprovedQuote ? await approvedQuoteOf(connection, input.job.jobId) : null;
  const contractorId = quote ? await approvedQuoteContractor(connection, input.job.jobId) : null;
  const facts = await loadApprovalFacts(connection, input.job.buildingId);
  const spend = {
    actor: input.actor,
    approvedQuote: quote ? { amount: quote.amount, contractorId } : null,
    buildingId: input.job.buildingId ?? 0,
    isContract: input.job.isContract,
    isTest: input.isTest,
    otherCommitted,
    poContractorId: input.poContractorId,
    stage: input.stage,
    thisAmount: input.thisAmount,
  };
  return { committedAfter: committedTotal(spend), otherCommitted, refusal: purchaseOrderSpendRefusal(spend, facts) };
}
