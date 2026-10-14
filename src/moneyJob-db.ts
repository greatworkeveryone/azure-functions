// The job a money record belongs to, read inside the caller's transaction with
// the row locked until commit, so the J3 rules (moneyRules.ts) decide on the
// state the write will land on.

import { TYPES, type Connection } from "tedious";
import { executeQuery } from "./db";

export interface MoneyJob {
  buildingId: number | null;
  /** Jobs.ApprovedQuoteID points at a quote on this job that is approved (or completed). */
  hasApprovedQuote: boolean;
  isArchived: boolean;
  isContract: boolean;
  isInternal: boolean;
  jobId: number;
  status: string;
}

export async function loadJobForMoney(connection: Connection, jobId: number): Promise<MoneyJob | null> {
  const rows = await executeQuery(
    connection,
    `SELECT j.JobID, j.Status, j.IsInternal, j.IsArchived, j.IsContract, j.BuildingID,
            CASE WHEN EXISTS (
              SELECT 1 FROM Quotes q
               WHERE q.QuoteID = j.ApprovedQuoteID AND q.JobID = j.JobID AND q.Status IN ('approved', 'completed')
            ) THEN 1 ELSE 0 END AS HasApprovedQuote
       FROM Jobs j WITH (UPDLOCK, HOLDLOCK)
      WHERE j.JobID = @JobID`,
    [{ name: "JobID", type: TYPES.Int, value: jobId }],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    buildingId: (row.BuildingID as number | null | undefined) ?? null,
    hasApprovedQuote: Boolean(row.HasApprovedQuote),
    isArchived: Boolean(row.IsArchived),
    isContract: Boolean(row.IsContract),
    isInternal: Boolean(row.IsInternal),
    jobId,
    status: String(row.Status ?? ""),
  };
}
