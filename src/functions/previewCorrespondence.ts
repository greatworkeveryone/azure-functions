// POST /api/previewCorrespondence
//   draft:  { kind, subject, bodyMarkdown, templateId?, templateVersion?, replyTo, signatureMode, recipient }
//   saved:  { correspondenceId, recipientId }
//
// One recipient's email exactly as they will receive it: the subject, the HTML and the plain text,
// with the sender, the reply-to and the signature as the server would compose them for this person.
// A field the recipient has no value for is not filled with a blank: the answer says `ready: false`
// and names each missing field. Nothing is saved or sent. Same roles as sending (ACTION_ROLES.sendEmail).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { readJsonBody } from "../assetRegisterSupport";
import { errorResponse } from "../auth";
import { authorizeActor, badRequest, forbidden, isSendManager, noStore, notFound, type CommsActor } from "../comms/actor";
import { composeForRecipient, type ComposeJob } from "../comms/compose";
import { fromName } from "../comms/config";
import { parsePreviewInput } from "../comms/request";
import { prepareSender } from "../comms/senderSetup";
import { readJob, readRecipient } from "../comms/store";
import type { Signature } from "../comms/signature";
import { closeConnection, createRequestConnection } from "../db";
import { checkRateLimit } from "../rateLimit";

function answer(job: ComposeJob, recipient: Parameters<typeof composeForRecipient>[1]) {
  const composed = composeForRecipient(job, recipient);
  const base = { replyTo: job.replyTo, signature: job.signature as Signature };
  return composed.ok
    ? { ...base, html: composed.email.html, missing: [], ready: true, subject: composed.email.subject, text: composed.email.text }
    : { ...base, detail: composed.detail, html: null, missing: composed.missing, ready: false, subject: null, text: null };
}

export async function previewCorrespondence(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeActor(request, ACTION_ROLES.sendEmail.gate, ACTION_ROLES.sendEmail.refused);
  if (!auth.ok) return auth.response;
  const { actor } = auth;
  const limited = checkRateLimit(`previewCorrespondence:${actor.oid}`, { limit: 60 });
  if (!limited.allowed) return { headers: { "Retry-After": String(Math.ceil(limited.retryAfterMs / 1000)) }, jsonBody: { error: "Too many requests, try again shortly" }, status: 429 };
  const body = await readJsonBody(request);
  if (!body) return badRequest("JSON object required");
  const input = parsePreviewInput(body);
  if (!input.ok) return badRequest(input.error);

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    if (input.value.kind === "saved") return await previewSaved(connection, actor, input.value.correspondenceId, input.value.recipientId);
    const { content, recipient } = input.value;
    const setup = await prepareSender(connection, actor, content);
    if (!setup.ok) return setup.response;
    const job: ComposeJob = {
      bodyMarkdown: content.bodyMarkdown,
      companyName: fromName(),
      createdByName: actor.name,
      kind: content.kind,
      replyTo: { address: setup.replyTo.address, name: setup.replyTo.name },
      signature: setup.signature,
      signatureMode: content.signatureMode,
      subject: content.subject,
    };
    return { headers: noStore, jsonBody: answer(job, recipient), status: 200 };
  } catch (error) {
    context.error("previewCorrespondence failed:", error instanceof Error ? error.message : error);
    return errorResponse("Could not preview the email", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

async function previewSaved(connection: Connection, actor: CommsActor, correspondenceId: number, recipientId: number): Promise<HttpResponseInit> {
  const job = await readJob(connection, correspondenceId);
  if (!job) return notFound("That send doesn't exist");
  if (job.createdByOid !== actor.oid && !isSendManager(actor.roles)) return forbidden("You can only preview your own sends");
  const recipient = await readRecipient(connection, correspondenceId, recipientId);
  if (!recipient) return notFound("That recipient isn't on this send");
  const compose: ComposeJob = {
    ...job,
    companyName: job.fromName,
    replyTo: { address: job.replyToAddress, name: job.replyToName },
  };
  return { headers: noStore, jsonBody: answer(compose, recipient), status: 200 };
}

app.http("previewCorrespondence", { authLevel: "anonymous", handler: previewCorrespondence, methods: ["POST"] });
