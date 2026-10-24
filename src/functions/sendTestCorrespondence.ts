// POST /api/sendTestCorrespondence  { kind, subject, bodyMarkdown, templateId?, templateVersion?, replyTo, signatureMode, recipient }
//
// A test of one recipient's email, sent to the person asking and nobody else. The address is the signed-in person's own
// stored email (never taken from the request); the recipient in the body only supplies the merge values,
// so the test reads as that recipient's email would. The subject starts "[Test]". It goes through the same
// queue as a real send (so COMMS_SEND_ENABLED, the dry run and DEV_EMAIL_OVERRIDE all apply), as the kind
// "system", which the history list and the approval count leave out. Same roles as sending (ACTION_ROLES.sendEmail): admin is refused.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { readJsonBody } from "../assetRegisterSupport";
import { errorResponse } from "../auth";
import { authorizeActor, badRequest, forbidden, noStore } from "../comms/actor";
import { fromAddress, fromName } from "../comms/config";
import { applyResolutions, checkRecipients, isBlocked, writeJob } from "../comms/queueJob";
import { parsePreviewInput } from "../comms/request";
import { prepareSender } from "../comms/senderSetup";
import type { NewJob } from "../comms/types";
import { findUserByOid } from "../comms/userSignatureStore";
import { closeConnection, createRequestConnection } from "../db";
import { checkRateLimit } from "../rateLimit";

export async function sendTestCorrespondence(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeActor(request, ACTION_ROLES.sendEmail.gate, ACTION_ROLES.sendEmail.refused);
  if (!auth.ok) return auth.response;
  const { actor } = auth;
  const limited = checkRateLimit(`sendTestCorrespondence:${actor.oid}`, { limit: 5 });
  if (!limited.allowed) return { headers: { "Retry-After": String(Math.ceil(limited.retryAfterMs / 1000)) }, jsonBody: { error: "Too many test emails, try again shortly" }, status: 429 };
  const body = await readJsonBody(request);
  if (!body) return badRequest("JSON object required");
  const input = parsePreviewInput(body);
  if (!input.ok) return badRequest(input.error);
  if (input.value.kind !== "draft") return badRequest("A test is made from the email as written, not from a saved send");
  const { content, recipient } = input.value;

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const setup = await prepareSender(connection, actor, content);
    if (!setup.ok) return setup.response;
    // The address is the stored one for the person's own staff record (its id travels with it, as a staff recipient's must).
    const user = await findUserByOid(connection, actor.oid);
    if (!user) return forbidden("Your account isn't set up in Floorplan, so a test can't be sent to you");
    const job: NewJob = {
      bodyMarkdown: content.bodyMarkdown,
      createdBy: { email: actor.email, name: actor.name, oid: actor.oid, role: actor.role },
      fromAddress: fromAddress(),
      fromName: fromName(),
      kind: "system",
      recipients: [{ address: user.email.toLowerCase(), mergeValues: recipient.mergeValues, name: recipient.name ?? actor.name, recipientRefId: String(user.userId), recipientType: "staff" }],
      replyTo: { address: setup.replyTo.address, identityId: setup.replyTo.identity?.identityId ?? null, name: setup.replyTo.name },
      signature: setup.signature,
      signatureMode: content.signatureMode,
      subject: `[Test] ${content.subject}`,
      templateId: content.templateId,
      templateVersion: content.templateVersion,
    };
    const [checked] = await applyResolutions(connection, checkRecipients(job));
    if (isBlocked(checked)) return badRequest(`The test can't be made yet. ${checked.refusal?.detail ?? (checked.composed.ok ? "" : checked.composed.detail)}`.trim());
    // Never waits for approval and is outside the 24 hour count: it is one message, kind system, to the person who asked.
    const queued = await writeJob(connection, job, [checked], actor, user?.userId ?? null, Number.MAX_SAFE_INTEGER);
    return { headers: noStore, jsonBody: { correspondenceId: queued.correspondenceId, sentTo: job.recipients[0].address, status: queued.status }, status: 201 };
  } catch (error) {
    context.error("sendTestCorrespondence failed:", error instanceof Error ? error.message : error);
    return errorResponse("Could not queue the test email", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("sendTestCorrespondence", { authLevel: "anonymous", handler: sendTestCorrespondence, methods: ["POST"] });
