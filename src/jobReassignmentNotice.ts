// UXA-09: reassigning a job tells the new owner. It uses the same pieces every other Floorplan email does
// (an active AppUsers address through resolveRecipient, the app link from the escalation config, graphSendMail
// behind the test-data egress guard) and never blocks or undoes the save: a failed send is logged and the job
// stays reassigned. The stall clock restart is in upsertJob (RESTART_STALL_CLOCK_SQL below).

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { absoluteLink } from "./escalation/config";
import { resolveRecipient } from "./email-recipient";
import { executeQuery } from "./db";
import { errorMessage } from "./errorMessage";
import { graphSendMail } from "./graph";
import type { EgressSubject } from "./test-data";

/**
 * Appended to the UPDATE when a job gets a different assignee. The stall clock starts at the later of an
 * acknowledgement and StatusSince (escalation/adapters/jobRules.ts stallClockStart), so the new owner gets a full
 * window: StatusSince is set to now and the acknowledgement and escalation marks left by the old owner are cleared.
 */
export const RESTART_STALL_CLOCK_SQL = ", StatusSince=SYSUTCDATETIME(), AcknowledgedAt=NULL, AcknowledgedBy=NULL, EscalatedAt=NULL";

export type SendNotice = (egress: EgressSubject, to: string[], subject: string, body: string) => Promise<void>;
const defaultSend: SendNotice = (egress, to, subject, body) => graphSendMail(egress, to, subject, body);

export function reassignmentEmail(input: { byName: string; fromName: string | null; jobId: number; link: string | null; title: string }): { body: string; subject: string } {
  const was = input.fromName ? ` It was with ${input.fromName}.` : "";
  return {
    body: [
      "Hi,",
      "",
      `${input.byName} gave you job #${input.jobId}: ${input.title}.${was}`,
      "The job's waiting clock starts again from now, so you have the full time to pick it up.",
      "",
      input.link ? `Open it in Floorplan: ${input.link}` : "Open Floorplan to see it.",
      "",
      "This email only points you to Floorplan.",
    ].join("\n"),
    subject: `Job #${input.jobId} was reassigned to you`,
  };
}

export type ReassignmentOutcome = "no_address" | "self" | "sent" | "failed";

/** Emails the new owner. Returns what happened; never throws. */
export async function notifyJobReassigned(
  connection: Connection,
  input: { byName: string; byOid: string; fromName: string | null; jobId: number; log?: (message: string) => void; toUserId: number },
  send: SendNotice = defaultSend,
): Promise<ReassignmentOutcome> {
  try {
    const rows = await executeQuery(
      connection,
      `SELECT u.Email, u.EntraOid, j.Title, j.IsTest
         FROM dbo.AppUsers u
         JOIN dbo.Jobs j ON j.JobID = @JobID
        WHERE u.UserID = @UserID AND u.IsActive = 1`,
      [
        { name: "JobID", type: TYPES.Int, value: input.jobId },
        { name: "UserID", type: TYPES.Int, value: input.toUserId },
      ],
    );
    const row = rows[0];
    if (!row) return "no_address";
    if (typeof row.EntraOid === "string" && row.EntraOid.toLowerCase() === input.byOid.toLowerCase()) return "self";
    const to = resolveRecipient(typeof row.Email === "string" ? row.Email : null).address;
    if (!to) return "no_address";
    const email = reassignmentEmail({
      byName: input.byName,
      fromName: input.fromName,
      jobId: input.jobId,
      link: absoluteLink(`/jobs?jobId=${input.jobId}`),
      title: String(row.Title ?? `Job #${input.jobId}`),
    });
    await send({ isTest: Boolean(row.IsTest) }, [to], email.subject, email.body);
    return "sent";
  } catch (error) {
    input.log?.(`Reassignment notice for job ${input.jobId} not sent: ${errorMessage(error)}`);
    return "failed";
  }
}
