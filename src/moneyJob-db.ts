// The job a money record belongs to, read inside the caller's transaction with
// the row locked until commit, so the J3 rules (moneyRules.ts) decide on the
// state the write will land on.

import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { TYPES, type Connection } from "tedious";
import { executeQuery, rollbackTransaction } from "./db";
import { resolveLedgerActor } from "./ledger/actor";
import { recordRefusal, type Refusal, type RefusalSubject } from "./ledger/refusals";
import { type MoneyRefusal, refusalResponse } from "./moneyRules";

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

/**
 * A control refusal on a money create or edit (J3 review): the decision's own
 * transaction is rolled back, the refused attempt is ledgered in a transaction
 * of its own (`denied`, recordRefusal), and the refusal is the answer. Plain
 * validation (an amount that isn't one) is answered without a row.
 */
export async function refuseMoneyChange(
  connection: Connection,
  request: HttpRequest,
  input: {
    /** `sod_blocked` for a self-approval block; `denied` otherwise. */
    action?: Refusal["action"];
    attempted: Refusal["attempted"];
    jobId: number;
    refusal: MoneyRefusal;
    state?: Record<string, unknown>;
    subject: RefusalSubject;
  },
): Promise<HttpResponseInit> {
  await rollbackTransaction(connection).catch(() => {});
  const actor = await resolveLedgerActor(request, connection).catch(() => null);
  if (actor) {
    await recordRefusal(
      connection,
      actor,
      input.subject,
      { action: input.action, attempted: input.attempted, code: input.refusal.code, message: input.refusal.message, state: input.state },
      input.jobId,
    );
  }
  return refusalResponse(input.refusal);
}
