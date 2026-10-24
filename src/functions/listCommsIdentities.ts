// GET /api/listCommsIdentities
//
// The reply-to choices this person has when they send email: each active identity their role
// may send on behalf of, with its team signature, plus their own address (offered only if it
// is on the company domain) with their standard signature. Nobody is shown an identity they
// can't use. Gated like sending (ACTION_ROLES.sendEmail); behind the emailSending flag in the app.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { errorResponse } from "../auth";
import { authorizeActor, noStore } from "../comms/actor";
import { isOrgAddress, mayUseIdentity } from "../comms/identity";
import { listIdentities } from "../comms/identityStore";
import { loadSignatureActor } from "../comms/senderSetup";
import { composeSignature } from "../comms/signature";
import { closeConnection, createRequestConnection } from "../db";

export async function listCommsIdentities(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeActor(request, ACTION_ROLES.sendEmail.gate, ACTION_ROLES.sendEmail.refused);
  if (!auth.ok) return auth.response;
  const { actor } = auth;

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const identities = (await listIdentities(connection, false))
      .filter((identity) => identity.isActive && mayUseIdentity(actor.roles, identity))
      .map((identity) => ({
        address: identity.address,
        displayName: identity.displayName,
        identityId: identity.identityId,
        signature: identity.signature,
        teamLabel: identity.teamLabel,
      }));
    const mine = composeSignature(await loadSignatureActor(connection, actor), "personal", null);
    return {
      headers: noStore,
      jsonBody: {
        identities,
        own: { address: actor.email.toLowerCase(), available: isOrgAddress(actor.email), name: actor.name, signature: mine.ok ? mine.signature : null },
      },
      status: 200,
    };
  } catch (error) {
    context.error("listCommsIdentities failed:", error instanceof Error ? error.message : error);
    return errorResponse("Could not load the reply-to addresses", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("listCommsIdentities", { authLevel: "anonymous", handler: listCommsIdentities, methods: ["GET"] });
