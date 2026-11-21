// The DB-facing half of the job step resolver (jobStepResolver.ts): reads the facts of many jobs in four batched
// queries (quotes, requested contractors, purchase orders, invoices; never one set per job) and attaches the derived
// `Step` and `NextAction` to each job row. getJob and every job list use it, so the Job Board, Overview, My work,
// the digest and the job's own header all print one answer. Invoice and quote rules are the guard's
// (jobTransitionFacts.summariseInvoices): an invoice is fully approved when director_approved, or approved where the
// director gate does not apply to its amount, so the label and the guard cannot disagree.

import { TYPES, type Connection } from "tedious";
import { decideAuthority, type Approver, type AuthorityFacts } from "./approvalAuthority";
import { loadApprovalFacts } from "./approvalAuthority-db";
import { executeQuery, type SqlParam, type SqlRow } from "./db";
import { resolveJobStep } from "./jobStepResolver";
import type { StepActor, StepApprover, StepFacts, StepStatus } from "./jobStepTypes";

const SET_ASIDE = new Set(["rejected", "superseded"]);

/** The role names an approval route uses, as a person reads them. */
const APPROVER_WORDS: Readonly<Record<string, string>> = {
  accounts: "accounts",
  accounts_manager: "an accounts manager",
  cfo: "the CFO",
  director: "a director",
  facilities_manager: "a facilities manager",
};

/** Who an approval goes to, from the approval-authority route's first step. Null when there is no route to read. */
export function approverOf(route: readonly Approver[]): StepApprover | null {
  const first = route[0];
  if (!first) return null;
  if (first.kind === "user") return { name: first.displayName ?? null, userId: first.userId ?? null };
  return first.role ? { name: APPROVER_WORDS[first.role] ?? first.role.replace(/_/g, " "), userId: null } : null;
}

const amountOf = (row: SqlRow): number => (row.Amount == null ? Number.NaN : Number(row.Amount));

function actorOf(row: SqlRow): StepActor | null {
  const name = typeof row.CreatedBy === "string" && row.CreatedBy.trim() !== "" ? row.CreatedBy : null;
  const oid = typeof row.CreatedByOid === "string" && row.CreatedByOid.trim() !== "" ? row.CreatedByOid : null;
  return name || oid ? { name, oid } : null;
}

function quoteFacts(job: SqlRow, quotes: readonly SqlRow[], requested: readonly SqlRow[], approval: AuthorityFacts): StepFacts["quotes"] {
  const count = (status: string) => quotes.filter((q) => q.Status === status).length;
  const waiting = quotes.find((q) => q.Status === "pending" || q.Status === "awaiting_approval");
  const route = waiting
    ? decideAuthority({ amount: amountOf(waiting), buildingId: 0, subject: "quote" }, approval)
    : null;
  return {
    approved: quotes.some((q) => q.QuoteID === job.ApprovedQuoteID && (q.Status === "approved" || q.Status === "completed")),
    approver: route ? approverOf(route.route) : null,
    awaitingApproval: count("awaiting_approval"),
    awaitingDirector: count("awaiting_director"),
    contractorsRequested: requested.length,
    declined: count("rejected"),
    pending: count("pending"),
    pendingCreator: waiting ? actorOf(waiting) : null,
    pendingNeedsDirector: route?.directorRequired ?? false,
    requestsSent: requested.filter((r) => r.RequestSent === true || r.RequestSent === 1).length,
  };
}

function invoiceFacts(invoices: readonly SqlRow[], approval: AuthorityFacts): StepFacts["invoices"] {
  const facts: StepFacts["invoices"] = {
    approvedNotInMyob: 0,
    approver: null,
    awaitingDirector: 0,
    incoming: 0,
    pending: 0,
    pendingCreator: null,
    pendingNeedsDirector: false,
    rejected: 0,
  };
  for (const row of invoices) {
    const status = typeof row.Status === "string" ? row.Status : "pending";
    const incoming = ((row.Direction as string | null) ?? "incoming") === "incoming";
    if (status === "rejected" && incoming) facts.rejected += 1;
    if (SET_ASIDE.has(status)) continue;
    const route = decideAuthority({ amount: amountOf(row), buildingId: 0, subject: "invoice" }, approval);
    const fullyApproved = status === "director_approved" || (status === "approved" && !route.directorRequired);
    if (fullyApproved && row.MyobCreatedAt == null) facts.approvedNotInMyob += 1;
    if (!incoming) continue;
    facts.incoming += 1;
    if (fullyApproved) continue;
    if (status === "approved") {
      facts.awaitingDirector += 1;
    } else {
      facts.pending += 1;
      if (facts.pending === 1) {
        facts.approver = approverOf(route.route);
        facts.pendingCreator = actorOf(row);
        facts.pendingNeedsDirector = route.directorRequired;
      }
    }
  }
  return facts;
}

/** One job's step facts from its row and its records. Pure: the I/O is in withJobSteps. */
export function buildStepFacts(
  job: SqlRow,
  records: { invoices: readonly SqlRow[]; purchaseOrders: readonly SqlRow[]; quotes: readonly SqlRow[]; requested: readonly SqlRow[] },
  approval: AuthorityFacts,
): StepFacts {
  const name = typeof job.AssignedTo === "string" && job.AssignedTo.trim() !== "" ? job.AssignedTo.trim() : null;
  return {
    assignee: { name, userId: job.AssignedToUserID == null ? null : Number(job.AssignedToUserID) },
    awaitingRole: job.AwaitingRole === "accounts" ? "accounts" : "facilities",
    invoices: invoiceFacts(records.invoices, approval),
    kind: job.IsInternal ? "internal" : job.IsContract ? "contract" : "standard",
    purchaseOrders: {
      complete: records.purchaseOrders.filter((p) => p.CompletedAt != null).length,
      notInMyob: records.purchaseOrders.filter((p) => p.MyobCreatedAt == null).length,
      raised: records.purchaseOrders.length,
    },
    quotes: quoteFacts(job, records.quotes, records.requested, approval),
    status: job.Status as StepStatus,
  };
}

function groupByJob(rows: readonly SqlRow[]): Map<number, SqlRow[]> {
  const byJob = new Map<number, SqlRow[]>();
  for (const row of rows) {
    const id = Number(row.JobID);
    byJob.set(id, [...(byJob.get(id) ?? []), row]);
  }
  return byJob;
}

/**
 * Sets Step and NextAction on job rows that carry the columns the resolver needs (JobID, Status, AwaitingRole,
 * IsContract, IsInternal, AssignedTo, AssignedToUserID, ApprovedQuoteID). Rows without a Status are left alone.
 * Four queries however many jobs there are.
 */
export async function withJobSteps(connection: Connection, rows: SqlRow[]): Promise<SqlRow[]> {
  const jobs = rows.filter((row) => typeof row.Status === "string" && row.JobID != null);
  if (jobs.length === 0) return rows;
  // One JSON array parameter, read with OPENJSON, so the ids are never part of the SQL text.
  const ids: SqlParam[] = [{ name: "JobIds", type: TYPES.NVarChar, value: JSON.stringify([...new Set(jobs.map((row) => Math.trunc(Number(row.JobID))))]) }];
  const IN_JOBS = "JobID IN (SELECT CAST([value] AS INT) FROM OPENJSON(@JobIds))";
  const [quotes, requested, purchaseOrders, invoices, approval] = await Promise.all([
    executeQuery(connection, `SELECT JobID, QuoteID, Status, Amount, CreatedBy, CreatedByOid FROM dbo.Quotes WHERE ${IN_JOBS}`, ids),
    executeQuery(connection, `SELECT JobID, RequestSent FROM dbo.JobRequestedContractors WHERE ${IN_JOBS}`, ids),
    executeQuery(connection, `SELECT JobID, CompletedAt, MyobCreatedAt FROM dbo.PurchaseOrders WHERE ${IN_JOBS}`, ids),
    executeQuery(connection, `SELECT JobID, Direction, Status, Amount, MyobCreatedAt, CreatedBy, CreatedByOid FROM dbo.JobInvoices WHERE ${IN_JOBS}`, ids),
    loadApprovalFacts(connection, null),
  ]);
  const by = {
    invoices: groupByJob(invoices),
    purchaseOrders: groupByJob(purchaseOrders),
    quotes: groupByJob(quotes),
    requested: groupByJob(requested),
  };
  return rows.map((row) => {
    if (typeof row.Status !== "string" || row.JobID == null) return row;
    const id = Number(row.JobID);
    const facts = buildStepFacts(
      row,
      {
        invoices: by.invoices.get(id) ?? [],
        purchaseOrders: by.purchaseOrders.get(id) ?? [],
        quotes: by.quotes.get(id) ?? [],
        requested: by.requested.get(id) ?? [],
      },
      approval,
    );
    const { nextAction, step } = resolveJobStep(facts);
    return { ...row, NextAction: nextAction, Step: step };
  });
}
