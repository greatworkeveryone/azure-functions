// src/email/director-emails.ts
//
// Sends the director packet to the active directors in AppUsers
// (DIRECTOR_APPROVAL_EMAILS only while there are none, reported as
// system.health), builds the packet, and sends a plain-text email with it
// attached. Best-effort — caller decides what to do with failures.

import { resolveRecipient } from "../email-recipient";
import { graphSendMail } from "../graph";
import { buildJobPacket, nonMergeableAttachments, type PacketInput } from "../pdf/job-packet";
import { loadJobPacketInputs } from "../pdf/job-packet-loader";
import { assertMayLeave, readIsTest } from "../test-data";
import type { Connection } from "tedious";
import { resolveRoleRecipients } from "./role-recipients";

/** The fallback list; recipients normally come from AppUsers (resolveRoleRecipients). */
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

/** What went out, for the ledger: no file contents, no addresses. */
export interface DirectorPacketSummary {
  /** Job and inspection-point files in the packet, merged into the PDF or not. */
  attachments: number;
  /** What the packet holds, in order: "job summary", "quote QT-9-1", "invoice IV-9-1"... */
  sections: string[];
  /** Files that can't be merged into the PDF and went as separate email attachments. */
  separateFiles: number;
}

export interface SendDirectorApprovalResult {
  /** Present on a real send; a stand-in that only returns who it sent to may leave it out. */
  packet?: DirectorPacketSummary;
  sentTo: string[];
  sentAt: Date;
}

function packetSummary(input: PacketInput, separateFiles: number): DirectorPacketSummary {
  const label = (kind: string, number: string | null | undefined, id: number): string => `${kind} ${number ?? `#${id}`}`;
  return {
    attachments: input.jobAttachments.length + input.sourcePointAttachments.length,
    sections: [
      "job summary",
      ...(input.selectedQuote ? [label("quote", input.selectedQuote.quoteNumber, input.selectedQuote.id)] : []),
      ...(input.purchaseOrder ? [label("purchase order", input.purchaseOrder.poNumber, input.purchaseOrder.id)] : []),
      ...(input.invoice ? [label("invoice", input.invoice.invoiceNumber, input.invoice.id)] : []),
    ],
    separateFiles,
  };
}

export async function sendDirectorApprovalEmail(
  args: SendDirectorApprovalArgs,
): Promise<SendDirectorApprovalResult> {
  const { addresses } = await resolveRoleRecipients(args.connection, "director", getDirectorEmails());
  // DEV_EMAIL_OVERRIDE applies at the send seam: staging runs on a copy of
  // production's AppUsers and must never mail the real directors.
  const recipients = [...new Set(addresses.map((a) => resolveRecipient(a).address).filter((a): a is string => !!a))];
  if (recipients.length === 0) {
    throw new Error("No director to email: no active director in AppUsers and DIRECTOR_APPROVAL_EMAILS is empty");
  }

  // A test job's packet never leaves Floorplan (D9).
  const isTest = await readIsTest(args.connection, "job", args.jobId);
  assertMayLeave("email", { isTest });

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
  // Replies are filed on the job but never count as a decision (SEC-07).
  const linkLine = jobUrl
    ? `Approve or reject in Floorplan: ${jobUrl}\nA reply to this email is filed on the job but does not count as a decision.`
    : "Open the job in Floorplan to approve or reject. A reply to this email does not count as a decision.";
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
    { isTest },
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

  return { packet: packetSummary(input, extras.length), sentTo: recipients, sentAt: new Date() };
}
