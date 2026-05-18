// src/email/director-emails.ts
//
// Loads director recipient list from env, builds the packet, and sends a
// plain-text email with the packet attached. Best-effort — caller decides
// what to do with failures.

import { graphSendMail } from "../graph";
import { buildJobPacket, nonMergeableAttachments } from "../pdf/job-packet";
import { loadJobPacketInputs } from "../pdf/job-packet-loader";
import type { Connection } from "tedious";

export function getDirectorEmails(): string[] {
  const raw = process.env.DIRECTOR_APPROVAL_EMAILS ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Deep-link to the job modal in the web app. Returns null when APP_BASE_URL
 *  isn't configured so the email still sends (link line is just omitted). */
export function buildJobUrl(jobId: number): string | null {
  const base = (process.env.APP_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!base) return null;
  return `${base}/jobs?jobId=${jobId}`;
}

export interface SendDirectorApprovalArgs {
  connection: Connection;
  jobId: number;
  stage: "quote" | "invoice";
  /** Used for the subject line and email body. */
  amount: number;
  currency: string;
  /** Display name of who triggered (approver / requester). */
  triggeredBy?: string;
}

export interface SendDirectorApprovalResult {
  sentTo: string[];
  sentAt: Date;
}

export async function sendDirectorApprovalEmail(
  args: SendDirectorApprovalArgs,
): Promise<SendDirectorApprovalResult> {
  const recipients = getDirectorEmails();
  if (recipients.length === 0) {
    throw new Error("DIRECTOR_APPROVAL_EMAILS env var is empty — no recipients configured");
  }

  const input = await loadJobPacketInputs(args.connection, args.jobId);
  const packet = await buildJobPacket(input);
  // Non-PDF / non-image attachments can't be merged into the packet — send
  // them as separate email attachments so the director has the originals.
  const extras = nonMergeableAttachments(input);

  const subject = `Director approval requested — Job #${args.jobId} (${args.stage}) — ${args.currency} ${args.amount.toFixed(2)}`;
  const extrasLine = extras.length
    ? `\n${extras.length} additional file${extras.length === 1 ? "" : "s"} attached separately: ${extras.map((e) => e.fileName).join(", ")}.`
    : "";
  const jobUrl = buildJobUrl(args.jobId);
  const linkLine = jobUrl
    ? `Open in Command Centre: ${jobUrl}`
    : "Open the job in Command Centre to approve or reject.";
  const body =
`Hi,

A ${args.stage} on Job #${args.jobId} requires director approval.

Job: ${input.job.title}
Building: ${input.job.buildingName}
Amount: ${args.currency} ${args.amount.toFixed(2)}
${args.triggeredBy ? `Approved by: ${args.triggeredBy}` : ""}

The full packet (job summary, ${args.stage === "quote" ? "selected quote" : "selected quote, PO, invoice"}, and attachments) is attached as a PDF.${extrasLine}

${linkLine}
`;

  await graphSendMail(
    recipients,
    subject,
    body.trim() + "\n",
    [
      {
        fileName: `job-${args.jobId}-packet.pdf`,
        contentType: "application/pdf",
        contentBase64: packet.toString("base64"),
      },
      ...extras.map((a) => ({
        fileName: a.fileName,
        contentType: a.contentType,
        contentBase64: a.bytes.toString("base64"),
      })),
    ],
  );

  return { sentTo: recipients, sentAt: new Date() };
}
