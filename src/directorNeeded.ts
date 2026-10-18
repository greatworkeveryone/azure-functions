// How many items on a job wait on a director (beta sprint J4): the "Director
// needed" filter, the action panels' pre-flag and the director's Planner task.
//
// The final-state rule, as the transition guard reads invoices
// (jobTransitionFacts.summariseInvoices): an invoice at stage 1 ('approved')
// waits on the director only when the approval-authority core says its amount
// needs one; below the gate, 'approved' is final. A quote in 'awaiting_director'
// always waits. Counting every stage-1 invoice, as before, flagged jobs no
// director had anything to do on.

import type { Connection } from "tedious";
import { decideAuthority, type AuthorityFacts } from "./approvalAuthority";
import { loadApprovalFacts } from "./approvalAuthority-db";
import type { SqlRow } from "./db";

/** SQL columns a query FROM Jobs adds so the count can be worked out. */
export const DIRECTOR_NEEDED_COLUMNS = `(SELECT COUNT(*) FROM Quotes q WHERE q.JobID = Jobs.JobID AND q.Status = 'awaiting_director') AS QuotesAwaitingDirector,
  (SELECT ji.Amount FROM JobInvoices ji WHERE ji.JobID = Jobs.JobID AND ji.Status = 'approved' FOR JSON PATH) AS StageOneInvoiceAmounts`;

/** The same, for a query that aliases Jobs as j. */
export const DIRECTOR_NEEDED_COLUMNS_J = `(SELECT COUNT(*) FROM dbo.Quotes q WHERE q.JobID = j.JobID AND q.Status = 'awaiting_director') AS QuotesAwaitingDirector,
  (SELECT ji.Amount FROM dbo.JobInvoices ji WHERE ji.JobID = j.JobID AND ji.Status = 'approved' FOR JSON PATH) AS StageOneInvoiceAmounts`;

/** The amounts of the job's stage-1 invoices, from the FOR JSON column (an unknown amount is NaN). */
function stageOneAmounts(value: unknown): number[] {
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const rows = JSON.parse(value) as { Amount?: unknown }[];
    return Array.isArray(rows) ? rows.map((row) => (row.Amount == null ? Number.NaN : Number(row.Amount))) : [];
  } catch {
    return [];
  }
}

/** Quotes awaiting the director, plus stage-1 invoices whose amount needs one. */
export function directorNeededCount(row: SqlRow, facts: AuthorityFacts): number {
  const quotes = Number(row.QuotesAwaitingDirector ?? 0);
  const invoices = stageOneAmounts(row.StageOneInvoiceAmounts).filter(
    (amount) => decideAuthority({ amount, buildingId: 0, subject: "invoice" }, facts).directorRequired,
  ).length;
  return (Number.isFinite(quotes) ? quotes : 0) + invoices;
}

/**
 * Sets DirectorNeededCount on job rows read with DIRECTOR_NEEDED_COLUMNS, and
 * drops the two working columns. Rows read without them are left as they are.
 */
export async function withDirectorNeeded(connection: Connection, rows: SqlRow[]): Promise<SqlRow[]> {
  if (!rows.some((row) => "QuotesAwaitingDirector" in row || "StageOneInvoiceAmounts" in row)) return rows;
  const facts = await loadApprovalFacts(connection, null);
  return rows.map((row) => {
    if (!("QuotesAwaitingDirector" in row || "StageOneInvoiceAmounts" in row)) return row;
    const { QuotesAwaitingDirector: _quotes, StageOneInvoiceAmounts: _invoices, ...rest } = row;
    return { ...rest, DirectorNeededCount: directorNeededCount(row, facts) };
  });
}
