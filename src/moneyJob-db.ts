// The job a money record belongs to, read inside the caller's transaction with
// the row locked until commit, so the J3 rules (moneyRules.ts) decide on the
// state the write will land on.

import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { TYPES, type Connection } from "tedious";
import { executeQuery, rollbackTransaction } from "./db";
import { resolveLedgerActor } from "./ledger/actor";
import { recordRefusal, type Refusal, type RefusalSubject } from "./ledger/refusals";
import { jobKindOf } from "./jobKinds";
import { adminJobRefusal, type MoneyRefusal, refusalResponse } from "./moneyRules";

export interface MoneyJob {
  buildingId: number | null;
  /** Jobs.ApprovedQuoteID points at a quote on this job that is approved (or completed). */
  hasApprovedQuote: boolean;
  isArchived: boolean;
  isContract: boolean;
  isInternal: boolean;
  jobId: number;
  /** Jobs.Kind; a job with none stored reads as facilities (jobKinds.ts). */
  kind: string;
  status: string;
}

export async function loadJobForMoney(connection: Connection, jobId: number): Promise<MoneyJob | null> {
  const rows = await executeQuery(
    connection,
    `SELECT j.JobID, j.Status, j.IsInternal, j.IsArchived, j.IsContract, j.BuildingID, j.Kind,
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
    kind: jobKindOf(row.Kind),
    status: String(row.Status ?? ""),
  };
}

/**
 * A0: the refusal for money on an admin job, for a handler that has the job's
 * id but no reason to lock the job (payments). Read without a lock on purpose:
 * a job's admin-ness is fixed when it is raised (jobs.ts, kind_fixed), so there
 * is no change to wait for, and the invoice handlers lock the job and then the
 * invoice, so a payment locking its invoice and then the job would deadlock
 * against them. A job that isn't found is not this rule's to refuse.
 */
export async function adminJobMoneyRefusal(connection: Connection, jobId: number): Promise<MoneyRefusal | null> {
  const rows = await executeQuery(connection, "SELECT Kind FROM Jobs WHERE JobID = @JobID", [
    { name: "JobID", type: TYPES.Int, value: jobId },
  ]);
  return rows.length === 0 ? null : adminJobRefusal(rows[0].Kind);
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
