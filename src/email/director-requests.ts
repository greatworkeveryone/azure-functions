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
// What is left is the stretch between Graph accepting the mail and the commit:
// if the database fails there, the mail is out with neither stamp nor row (the
// stamp always had that exposure). Everything the row needs is found before the
// mail goes, so only the database itself failing can do it.

import { TYPES, type Connection } from "tedious";
import { beginTransaction, commitTransaction, executeQuery, rollbackTransaction } from "../db";
import { record } from "../ledger";
import { jobScope } from "../ledger/moneyDecisions";
import { recordApart, underRowLimit } from "../ledger/refusals";
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
                   DirectorEmailSentBy = @SentBy
             WHERE JobInvoiceID = @Id`,
  quote: `UPDATE Quotes
               SET DirectorEmailSentAt = @SentAt,
                   DirectorEmailSentTo = @SentTo,
                   DirectorEmailSentBy = @SentBy
             WHERE QuoteID = @Id`,
};

export interface DirectorRequest {
  /** The person who asked for it: the approver, or whoever pressed resend. */
  actor: LedgerActor;
  amount: number;
  connection: Connection;
  /** Shared with the decision that triggered the request, when there is one. */
  correlationId?: string;
  currency: string;
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
  const { actor, amount, connection, correlationId, currency, jobId, resend, stage, subjectId, triggeredBy } = request;
  const subject = { id: subjectId, type: stage } as const;
  // Loaded here, not at the top of the file: it pulls in the PDF and Graph code.
  const { sendDirectorApprovalEmail } = await import("./director-emails");

  // Found before the mail goes, so that once it has, recording it can fail only
  // if the database does.
  const scope = await jobScope(connection, jobId);

  let result: SendDirectorApprovalResult;
  try {
    result = await sendDirectorApprovalEmail({ amount, connection, currency, jobId, stage, triggeredBy });
  } catch (err) {
    if (underRowLimit(actor, `failed ${stage} director request`)) {
      await recordApart(
        connection,
        {
          action: ACTIONS[stage].failed,
          actor,
          // The error's own text is for the logs: it can carry addresses.
          after: { amount, currency, resend },
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
    throw err;
  }
  return result;
}
