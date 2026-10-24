// POST /api/queueCorrespondence  { kind, subject, bodyMarkdown, templateId?, templateVersion?, replyTo, signatureMode, recipients, idempotencyKey? }
//
// Creates a send job: one message per recipient, from the one Randazzo Properties sender, with the
// reply-to the caller chose (an identity their role may use, or their own company address) and a
// signature the server composes (the identity's team signature, or the caller's own). A request that
// carries signature text, a sender or another person's details is refused. A job to more recipients than
// COMMS_APPROVAL_THRESHOLD (default 20) waits for a manager (approveCorrespondence); a smaller one is
// queued. Recipients with a missing merge field are stored blocked and named; if none can be sent
// nothing is created. Nothing goes out here: the queue timer sends, and only when COMMS_SEND_ENABLED
// is "true". Same roles as sending (ACTION_ROLES.sendEmail); a broadcast needs ACTION_ROLES.sendBroadcast too.
// An idempotencyKey (one per compose session) makes a repeated submit return the job already made (200, repeated: true) instead of queuing a second.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { readJsonBody } from "../assetRegisterSupport";
import { errorResponse, rolesPassGate } from "../auth";
import { authorizeActor, badRequest, forbidden, noStore } from "../comms/actor";
import { approvalThreshold, fromAddress, fromName } from "../comms/config";
import { findUserByOid } from "../comms/userSignatureStore";
import { checkRecipients, writeJob } from "../comms/queueJob";
import { parseQueueInput } from "../comms/request";
import { prepareSender } from "../comms/senderSetup";
import type { NewJob } from "../comms/types";
import { closeConnection, createRequestConnection } from "../db";
import { checkRateLimit } from "../rateLimit";

export async function queueCorrespondence(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeActor(request, ACTION_ROLES.sendEmail.gate, ACTION_ROLES.sendEmail.refused);
  if (!auth.ok) return auth.response;
  const { actor } = auth;
  const limited = checkRateLimit(`queueCorrespondence:${actor.oid}`, { limit: 10 });
  if (!limited.allowed) return { headers: { "Retry-After": String(Math.ceil(limited.retryAfterMs / 1000)) }, jsonBody: { error: "Too many sends, try again shortly" }, status: 429 };
  const body = await readJsonBody(request);
  if (!body) return badRequest("JSON object required");
  const input = parseQueueInput(body);
  if (!input.ok) return badRequest(input.error);
  // A broadcast is for managers and directors; a letter to one tenancy stays with everyone who may send.
  if (input.value.kind === "broadcast" && !rolesPassGate(actor.roles, ACTION_ROLES.sendBroadcast.gate)) return forbidden("Only managers and directors can send a broadcast");

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const setup = await prepareSender(connection, actor, input.value);
    if (!setup.ok) return setup.response;
    const job: NewJob = {
      bodyMarkdown: input.value.bodyMarkdown,
      createdBy: { email: actor.email, name: actor.name, oid: actor.oid, role: actor.role },
      fromAddress: fromAddress(),
      fromName: fromName(),
      kind: input.value.kind,
      recipients: input.value.recipients,
      replyTo: { address: setup.replyTo.address, identityId: setup.replyTo.identity?.identityId ?? null, name: setup.replyTo.name },
      signature: setup.signature,
      signatureMode: input.value.signatureMode,
      subject: input.value.subject,
      templateId: input.value.templateId,
      templateVersion: input.value.templateVersion,
    };
    const checked = checkRecipients(job);
    if (checked.every((entry) => !entry.composed.ok)) {
      const first = checked[0].composed;
      return badRequest(`No recipient can be sent this email. ${first.ok ? "" : first.detail}`.trim());
    }
    const user = await findUserByOid(connection, actor.oid);
    const queued = await writeJob(connection, job, checked, actor, user?.userId ?? null, approvalThreshold(), input.value.idempotencyKey);
    return { headers: noStore, jsonBody: { ...queued, duplicatesDropped: input.value.duplicatesDropped, requiresApproval: queued.status === "awaiting_approval" }, status: queued.repeated ? 200 : 201 };
  } catch (error) {
    context.error("queueCorrespondence failed:", error instanceof Error ? error.message : error);
    return errorResponse("Could not queue the email", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("queueCorrespondence", { authLevel: "anonymous", handler: queueCorrespondence, methods: ["POST"] });
