// src/email/director-requests.ts
//
// Sending the director's approval request, and recording that it went (PLAN
// §3.12: every external send is ledgered). Used by the request that follows a
// quote or invoice approval and by the resend buttons, for quotes and invoices.
//
// The stamp on the quote or invoice (DirectorEmailSentAt/To/By) means "sent",
// and the e-mail decision check relies on it, so it is written only after Graph
// has accepted the mail. The ledger row goes in the same transaction as the
// stamp: a `*.director_request_sent` row means the mail went, never that it was
// about to. A send that fails leaves no stamp and a `*.director_request_failed`
// row, written in a transaction of its own.
//
// The stretch between Graph accepting the mail and the commit is covered by a
// claim (DirectorEmailAttemptedAt), taken atomically before the mail goes and
// cleared by the stamp or by a failed send. If the database fails after the
// mail left, the claim stays (and goes to Sentry): the next send is refused
// with DirectorRequestClaimedError until a person has checked, instead of
// quietly mailing the directors twice.

import { TYPES, type Connection } from "tedious";
import { beginTransaction, commitTransaction, executeQuery, rollbackTransaction } from "../db";
import { record } from "../ledger";
import { jobScope } from "../ledger/moneyDecisions";
import { recordApart, underRowLimit } from "../ledger/refusals";
import { Sentry } from "../sentry";
import type { LedgerActor } from "../ledger/types";
import type { SendDirectorApprovalResult } from "./director-emails";

type Stage = "invoice" | "quote";

const ACTIONS = {
  invoice: { failed: "invoice.director_request_failed", sent: "invoice.director_request_sent" },
  quote: { failed: "quote.director_request_failed", sent: "quote.director_request_sent" },
} as const;

const STAMP_SQL: Record<Stage, string> = {
  invoice: `UPDATE JobInvoices
               SET DirectorEmailSentAt = @SentAt,
                   DirectorEmailSentTo = @SentTo,
                   DirectorEmailSentBy = @SentBy,
                   DirectorEmailAttemptedAt = NULL
             WHERE JobInvoiceID = @Id`,
  quote: `UPDATE Quotes
               SET DirectorEmailSentAt = @SentAt,
                   DirectorEmailSentTo = @SentTo,
                   DirectorEmailSentBy = @SentBy,
                   DirectorEmailAttemptedAt = NULL
             WHERE QuoteID = @Id`,
};

const TABLES: Record<Stage, { id: string; table: string }> = {
  invoice: { id: "JobInvoiceID", table: "JobInvoices" },
  quote: { id: "QuoteID", table: "Quotes" },
};

/** A earlier send was started and never recorded as finished: the mail may have gone. */
export class DirectorRequestClaimedError extends Error {
  constructor(readonly attemptedAt: Date | null) {
    super(
      `A director approval email was already started${attemptedAt ? ` at ${attemptedAt.toISOString()}` : ""} and may have been sent; ` +
        "check with the director before sending it again.",
    );
    this.name = "DirectorRequestClaimedError";
  }
}

/** Takes the send claim, or throws DirectorRequestClaimedError. Atomic: one UPDATE. */
async function claimSend(connection: Connection, stage: Stage, subjectId: number): Promise<void> {
  const { id: ID_COLUMN, table: TABLE } = TABLES[stage];
  const params = [{ name: "Id", type: TYPES.Int, value: subjectId }];
  const claimed = await executeQuery(
    connection,
    `UPDATE ${TABLE} SET DirectorEmailAttemptedAt = SYSUTCDATETIME()
     OUTPUT inserted.${ID_COLUMN} AS Id
     WHERE ${ID_COLUMN} = @Id AND DirectorEmailAttemptedAt IS NULL`,
    params,
  );
  if (claimed.length > 0) return;
  const existing = await executeQuery(connection, `SELECT DirectorEmailAttemptedAt FROM ${TABLE} WHERE ${ID_COLUMN} = @Id`, params);
  if (existing.length === 0) throw new Error(`${stage} ${subjectId} not found`);
  throw new DirectorRequestClaimedError((existing[0].DirectorEmailAttemptedAt as Date | null) ?? null);
}

/** The mail did not go: give the claim back. Best effort; a stuck claim only blocks a resend. */
async function releaseClaim(connection: Connection, stage: Stage, subjectId: number): Promise<void> {
  const { id: ID_COLUMN, table: TABLE } = TABLES[stage];
  await executeQuery(connection, `UPDATE ${TABLE} SET DirectorEmailAttemptedAt = NULL WHERE ${ID_COLUMN} = @Id`, [
    { name: "Id", type: TYPES.Int, value: subjectId },
  ]).catch(() => undefined);
}

export interface DirectorRequest {
  /** The person who asked for it: the approver, or whoever pressed resend. */
  actor: LedgerActor;
  amount: number;
  connection: Connection;
  /** Shared with the decision that triggered the request, when there is one. */
  correlationId?: string;
  currency: string;
  /** What the quote or invoice is, in the keys every money row carries: its
   *  amount, who it is for, its number. */
  facts: Record<string, unknown>;
  jobId: number;
  resend: boolean;
  stage: Stage;
  /** The QuoteID or JobInvoiceID the request is about. */
  subjectId: number;
  /** Stamped as SentBy and named in the email. */
  triggeredBy: string;
}

/** The names of the people the request went to, never their addresses. An
 *  address with no name behind it is counted, not shown. */
async function recipientNames(
  connection: Connection,
  addresses: string[],
): Promise<{ names: string[]; unnamed: number }> {
  const emails = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter((a) => a.length > 0))];
  if (emails.length === 0) return { names: [], unnamed: 0 };
  try {
    const placeholders = emails.map((_, i) => `@Email${i}`).join(", ");
    const rows = await executeQuery(
      connection,
      `SELECT DisplayName FROM dbo.AppUsers WHERE Email IN (${placeholders}) AND IsActive = 1`,
      emails.map((value, i) => ({ name: `Email${i}`, type: TYPES.NVarChar, value })),
    );
    // A display name that is just the address (what someone invited without a
    // name gets) is not a name.
    const names = rows
      .map((r) => (typeof r.DisplayName === "string" ? r.DisplayName.trim() : ""))
      .filter((name) => name.length > 0 && !name.includes("@"))
      .sort();
    return { names, unnamed: Math.max(emails.length - names.length, 0) };
  } catch {
    // Who it went to is worth recording; not worth losing the record over.
    return { names: [], unnamed: emails.length };
  }
}

/**
 * Sends the director approval request and records it. Throws whatever the send
 * threw, after recording the failure; the caller keeps its own handling.
 */
export async function sendDirectorRequest(request: DirectorRequest): Promise<SendDirectorApprovalResult> {
  const { actor, amount, connection, correlationId, currency, facts, jobId, resend, stage, subjectId, triggeredBy } = request;
  const subject = { id: subjectId, type: stage } as const;
  // Loaded here, not at the top of the file: it pulls in the PDF and Graph code.
  const { sendDirectorApprovalEmail } = await import("./director-emails");

  // Found before the mail goes, so that once it has, recording it can fail only
  // if the database does.
  const scope = await jobScope(connection, jobId);
  await claimSend(connection, stage, subjectId);

  let result: SendDirectorApprovalResult;
  try {
    result = await sendDirectorApprovalEmail({ amount, connection, currency, jobId, stage, subjectId, triggeredBy });
  } catch (err) {
    await releaseClaim(connection, stage, subjectId);
    if (underRowLimit(actor, `failed ${stage} director request`)) {
      await recordApart(
        connection,
        {
          action: ACTIONS[stage].failed,
          actor,
          // The error's own text is for the logs: it can carry addresses.
          after: { ...facts, amount, currency, resend },
          buildingId: scope.buildingId,
          correlationId,
          jobId: scope.jobId,
          reason: "The director approval email could not be sent",
          ruleApplied: "send_failed",
          subject,
        },
        `failed ${stage} director request`,
        "ledger-send-failure",
      );
    }
    throw err;
  }

  const recipients = await recipientNames(connection, result.sentTo);
  await beginTransaction(connection);
  try {
    await executeQuery(connection, STAMP_SQL[stage], [
      { name: "Id", type: TYPES.Int, value: subjectId },
      { name: "SentAt", type: TYPES.DateTime2, value: result.sentAt },
      { name: "SentTo", type: TYPES.NVarChar, value: JSON.stringify(result.sentTo) },
      { name: "SentBy", type: TYPES.NVarChar, value: triggeredBy },
    ]);
    await record(connection, {
      action: ACTIONS[stage].sent,
      actor,
      after: {
        ...facts,
        amount,
        currency,
        packet: result.packet ?? null,
        recipients: recipients.names,
        resend,
        unnamedRecipients: recipients.unnamed,
      },
      buildingId: scope.buildingId,
      correlationId,
      jobId: scope.jobId,
      subject,
    });
    await commitTransaction(connection);
  } catch (err) {
    await rollbackTransaction(connection).catch(() => {});
    // The mail is out and unrecorded; the claim stays so nobody sends it again blind.
    Sentry.captureException(err, { extra: { stage, subjectId, note: "director request sent but not recorded" } });
    throw err;
  }
  return result;
}

/**
 * The send that follows an approval, awaited so the Functions host cannot cut
 * it short. The approval has already happened, so a failure is reported, not
 * thrown: true means the email did not go (the failure is ledgered).
 */
export async function sendDirectorRequestAfterApproval(request: DirectorRequest, warn: (message: string) => void): Promise<boolean> {
  try {
    await sendDirectorRequest(request);
    return false;
  } catch (err) {
    warn(`Director email failed for ${request.stage} ${request.subjectId}: ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
}
