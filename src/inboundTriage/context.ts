// Inbound email triage (EB3): what an email is about and who it concerns. Work comes from Toddler's
// parse when the row has one, else the AI gateway when it is on, else keyword rules. The context
// then pins the email to a building, a tenancy and a job from records, trusting a name or number
// from an email or a model only when Floorplan's own tables agree with it: a job number must be a
// live job, a name must match exactly one building or tenancy.

import type { Connection } from "tedious";
import { todayInDarwin } from "../darwinDate";
import { readWithAi } from "./aiStep";
import { buildingByName, buildingNameById, loadJob, matchSender, UNKNOWN_SENDER, tenancyById, tenancyByName, type NamedJob } from "./load";
import { linkedSendFor } from "./replyLink";
import { rulesWork, toddlerWork } from "./workInference";
import type { LinkedSend, TriageContext, Work } from "./types";

export interface TriageEmail {
  aiClassification: string | null;
  aiFlagged: boolean;
  aiParsedData: string | null;
  body: string | null;
  emailId: number;
  fromAddress: string | null;
  inReplyTo: string | null;
  isTest: boolean;
  mailbox: string | null;
  matchedJobId: number | null;
  receivedAt: Date | null;
  referenceIds: string | null;
  /** Emails.SenderAuthenticated: true only when Exchange verified the From address; null when it was never checked. */
  senderAuthenticated: boolean | null;
  subject: string | null;
}

/** Toddler's reading when it made one, else the model's when the gateway is on, else the keyword rules. */
export async function readWork(email: TriageEmail): Promise<Work> {
  const rules = rulesWork(email.subject, email.body);
  if (!email.aiFlagged) {
    const fromToddler = toddlerWork(email.aiClassification, email.aiParsedData, rules);
    if (fromToddler) return fromToddler;
  }
  return (await readWithAi(email.emailId, email.subject, email.body, rules)) ?? rules;
}

const sameAddress = (a: string | null, b: string | null): boolean => a !== null && b !== null && a.trim() !== "" && a.trim().toLowerCase() === b.trim().toLowerCase();

export interface BuiltContext {
  context: TriageContext;
  namedJob: NamedJob | null;
}

/** The send the email answers (a failed lookup is no link, never a failed triage). */
async function safeLinkedSend(connection: Connection, email: TriageEmail): Promise<LinkedSend | null> {
  try {
    return await linkedSendFor(connection, email);
  } catch {
    return null;
  }
}

export async function buildContext(connection: Connection, email: TriageEmail, work: Work, now: Date): Promise<BuiltContext> {
  // A From address Exchange could not verify may be anyone's. Nothing that rests on who sent the email is
  // looked up for it: not the tenancy or contractor it claims to be, nor the send it claims to answer.
  const senderVerified = email.senderAuthenticated === true;
  const linkedSend = senderVerified ? await safeLinkedSend(connection, email) : null;
  const sender = senderVerified ? await matchSender(connection, email.fromAddress) : UNKNOWN_SENDER;
  const replyVerified = linkedSend !== null && sameAddress(linkedSend.recipientEmail, email.fromAddress);
  const jobId = email.matchedJobId ?? work.jobNumber;
  const namedJob = jobId ? await loadJob(connection, jobId) : null;
  const namedTenancy = work.tenancyName ? await tenancyByName(connection, work.tenancyName) : null;
  const namedBuilding = work.buildingName ? await buildingByName(connection, work.buildingName) : null;

  // The most deliberate source wins, field by field: a job the email names, the send it answers, who wrote it, then names.
  const buildingId = namedJob?.buildingId ?? linkedSend?.buildingId ?? sender.buildingId ?? namedBuilding?.buildingId ?? namedTenancy?.buildingId ?? null;
  const tenancyId = namedJob?.tenancyId ?? linkedSend?.tenancyId ?? sender.tenancyId ?? namedTenancy?.tenancyId ?? null;
  const tenancy = tenancyId === null ? null : (namedTenancy?.tenancyId === tenancyId ? namedTenancy : await tenancyById(connection, tenancyId));

  return {
    context: {
      buildingId,
      buildingName: buildingId === null ? null : (namedBuilding?.buildingId === buildingId ? namedBuilding.name : await buildingNameById(connection, buildingId)),
      category: work.category,
      contractorId: sender.contractorId,
      emailId: email.emailId,
      intent: work.intent,
      lane: work.lane,
      // The recipient's address is not kept: the log holds ids and plain sentences, not who was emailed.
      linkedSend: linkedSend ? { ...linkedSend, recipientEmail: null } : null,
      mailbox: email.mailbox,
      matchedJobId: namedJob?.jobId ?? null,
      replyVerified,
      senderKind: sender.kind,
      senderVerified,
      tenancyId,
      tenancyName: tenancy?.name ?? null,
      today: todayInDarwin(now),
      urgency: work.urgency,
    },
    namedJob,
  };
}
