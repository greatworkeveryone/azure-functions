// Who an email is from and how it is signed: the reply-to resolved against the identities
// this person may use, and the signature composed on the server. Shared by the preview and
// the queue so both show and send the same thing.

import type { HttpResponseInit } from "@azure/functions";
import type { Connection } from "tedious";
import { badRequest, forbidden, notFound, type CommsActor } from "./actor";
import { resolveReplyTo, type ResolvedReplyTo } from "./identity";
import { readIdentity } from "./identityStore";
import { findUserByOid, readUserSignature } from "./userSignatureStore";
import type { EmailContent } from "./request";
import { composeSignature, type Signature, type SignatureActor } from "./signature";

export type SenderSetup = { ok: true; replyTo: ResolvedReplyTo; signature: Signature } | { ok: false; response: HttpResponseInit };

/** The signed-in person's own standard-signature facts: name and email from the token, title and phone from Floorplan. */
export async function loadSignatureActor(connection: Connection, actor: CommsActor): Promise<SignatureActor> {
  const user = await findUserByOid(connection, actor.oid);
  const fields = user ? await readUserSignature(connection, user.userId) : { jobTitle: null, phone: null };
  return { email: actor.email, jobTitle: fields.jobTitle, name: actor.name, phone: fields.phone };
}

export async function prepareSender(connection: Connection, actor: CommsActor, content: Pick<EmailContent, "replyTo" | "signatureMode">): Promise<SenderSetup> {
  const identity = content.replyTo.kind === "identity" ? await readIdentity(connection, content.replyTo.identityId) : null;
  const resolved = resolveReplyTo(actor, content.replyTo, identity);
  if (!resolved.ok) return { ok: false, response: resolved.status === 404 ? notFound(resolved.error) : forbidden(resolved.error) };
  const composed = composeSignature(await loadSignatureActor(connection, actor), content.signatureMode, resolved.value.identity);
  if (!composed.ok) return { ok: false, response: badRequest(composed.error) };
  return { ok: true, replyTo: resolved.value, signature: composed.signature };
}
