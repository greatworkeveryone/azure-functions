// Reply-to-approve is off (decision 2, SEC-07). When an operator records a
// director's emailed reply, it is filed on the quote's job as an
// `email.reply_linked` event and the email leaves Incoming; no decision is
// applied. The answer carries the job's link so the director decides in-app.

import type { HttpResponseInit } from "@azure/functions";
import { TYPES, type Connection } from "tedious";
import { beginTransaction, commitTransaction, executeQuery, rollbackTransaction } from "../db";
import { jobLink } from "../plannerHelpers";

export interface LinkDirectorReplyArgs {
  emailId: number;
  operatorName: string;
  quoteId: number;
}

export async function linkDirectorReply(conn: Connection, args: LinkDirectorReplyArgs): Promise<HttpResponseInit> {
  const emails = await executeQuery(
    conn,
    "SELECT EmailID, FromAddress, Status, MatchedJobID FROM Emails WHERE EmailID = @Id",
    [{ name: "Id", type: TYPES.Int, value: args.emailId }],
  );
  if (emails.length === 0) return { status: 404, jsonBody: { error: "Email not found" } };
  const status = (emails[0].Status as string | null) ?? "";
  if (status === "promoted" || status === "archived") {
    return { status: 409, jsonBody: { error: "This email has already been handled" } };
  }
  const quotes = await executeQuery(
    conn,
    "SELECT JobID, QuoteNumber, Status FROM Quotes WHERE QuoteID = @Id",
    [{ name: "Id", type: TYPES.Int, value: args.quoteId }],
  );
  if (quotes.length === 0) return { status: 404, jsonBody: { error: "Quote not found" } };
  const jobId = quotes[0].JobID as number;
  const matched = (emails[0].MatchedJobID as number | null) ?? null;
  if (matched !== null && matched !== jobId) {
    return { status: 422, jsonBody: { error: "Email is not matched to this quote's job" } };
  }

  const sender = ((emails[0].FromAddress as string | null) ?? "").trim() || "unknown sender";
  const quoteLabel = (quotes[0].QuoteNumber as string | null) ?? `#${args.quoteId}`;
  await beginTransaction(conn);
  try {
    await executeQuery(
      conn,
      `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, QuoteID, SourceEmailID)
       VALUES (@JobID, @CreatedBy, @Text, 'email.reply_linked', @QuoteID, @EmailID);`,
      [
        { name: "JobID", type: TYPES.Int, value: jobId },
        { name: "CreatedBy", type: TYPES.NVarChar, value: args.operatorName },
        {
          name: "Text",
          type: TYPES.NVarChar,
          value: `Reply from ${sender} filed on this job. It is not a decision: approve or reject quote ${quoteLabel} in Floorplan.`,
        },
        { name: "QuoteID", type: TYPES.Int, value: args.quoteId },
        { name: "EmailID", type: TYPES.Int, value: args.emailId },
      ],
    );
    const flipped = await executeQuery(
      conn,
      `UPDATE Emails SET Status = 'promoted', MatchedJobID = @JobID, ProcessedAt = SYSUTCDATETIME()
       OUTPUT inserted.EmailID
       WHERE EmailID = @Id AND Status NOT IN ('promoted', 'archived')`,
      [
        { name: "Id", type: TYPES.Int, value: args.emailId },
        { name: "JobID", type: TYPES.Int, value: jobId },
      ],
    );
    if (flipped.length === 0) {
      await rollbackTransaction(conn);
      return { status: 409, jsonBody: { error: "Email was handled concurrently — reload and try again" } };
    }
    await commitTransaction(conn);
  } catch (err) {
    await rollbackTransaction(conn).catch(() => undefined);
    throw err;
  }

  // 403 keeps the existing client contract: the decision itself was refused.
  const base = (process.env.APP_BASE_URL ?? "").trim();
  return {
    status: 403,
    jsonBody: {
      code: "EMAIL_REPLY_DECISIONS_DISABLED",
      error: "Decisions are made in Floorplan. The reply is now on the job — open it to approve or reject.",
      jobId,
      jobUrl: base ? jobLink(base, jobId, { step: "quotes" }) : null,
      linked: true,
    },
  };
}
