// GET /api/getMySignature
//
// The signed-in person's standard signature as it will print: their name from their sign-in,
// the job title and phone they keep here, and their own address when it is on the company
// domain. Any assigned role (ACTION_ROLES.editMySignature); it reads only the caller's own row.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { errorResponse } from "../auth";
import { authorizeActor, noStore } from "../comms/actor";
import { isOrgAddress } from "../comms/identity";
import { findUserByOid, readUserSignature } from "../comms/userSignatureStore";
import { composeSignature } from "../comms/signature";
import { closeConnection, createRequestConnection } from "../db";

export async function getMySignature(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeActor(request, ACTION_ROLES.editMySignature.gate);
  if (!auth.ok) return auth.response;
  const { actor } = auth;

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const user = await findUserByOid(connection, actor.oid);
    const fields = user ? await readUserSignature(connection, user.userId) : { jobTitle: null, phone: null, updatedAt: null };
    const composed = composeSignature({ email: actor.email, jobTitle: fields.jobTitle, name: actor.name, phone: fields.phone }, "personal", null);
    return {
      headers: noStore,
      jsonBody: {
        email: actor.email.toLowerCase(),
        emailShown: isOrgAddress(actor.email),
        jobTitle: fields.jobTitle,
        name: actor.name,
        phone: fields.phone,
        signature: composed.ok ? composed.signature : null,
        // A person with no Floorplan user row can't save a title and phone: the screen says so.
        userId: user?.userId ?? null,
      },
      status: 200,
    };
  } catch (error) {
    context.error("getMySignature failed:", error instanceof Error ? error.message : error);
    return errorResponse("Could not load your signature", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getMySignature", { authLevel: "anonymous", handler: getMySignature, methods: ["GET"] });
