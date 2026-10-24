// POST /api/updateMySignature  { jobTitle, phone, userId? }
//
// Saves the job title and phone that go under the caller's name in their standard signature.
// Only those two fields: the name and address come from the sign-in, and a request carrying
// anything else (signature text, a sender, another address) is refused. `userId` is for an admin
// editing someone else's; anyone else naming a different person is refused. Any assigned role
// edits their own (ACTION_ROLES.editMySignature).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { AppRole, errorResponse } from "../auth";
import { authorizeActor, badRequest, forbidden, noStore, notFound } from "../comms/actor";
import { findUserById, findUserByOid, writeUserSignature } from "../comms/identityStore";
import { unexpectedKey, wholeId } from "../comms/request";
import { parseUserSignature } from "../comms/signature";
import { closeConnection, createRequestConnection } from "../db";
import { readJsonBody } from "../assetRegisterSupport";
import { checkRateLimit } from "../rateLimit";

export async function updateMySignature(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeActor(request, ACTION_ROLES.editMySignature.gate);
  if (!auth.ok) return auth.response;
  const { actor } = auth;
  const limited = checkRateLimit(`updateMySignature:${actor.oid}`, { limit: 20 });
  if (!limited.allowed) return { headers: { "Retry-After": String(Math.ceil(limited.retryAfterMs / 1000)) }, jsonBody: { error: "Too many requests, try again shortly" }, status: 429 };
  const body = await readJsonBody(request);
  if (!body) return badRequest("JSON object required");
  const extra = unexpectedKey(body, ["jobTitle", "phone", "userId"]);
  if (extra) return badRequest(extra);
  const fields = parseUserSignature({ jobTitle: body.jobTitle, phone: body.phone });
  if (!fields.ok) return badRequest(fields.error);

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const own = await findUserByOid(connection, actor.oid);
    let target = own;
    if (body.userId !== undefined && body.userId !== null) {
      const userId = wholeId(body.userId);
      if (userId === null) return badRequest("userId must be a whole number");
      if (userId !== own?.userId) {
        if (!actor.roles.includes(AppRole.ADMIN)) return forbidden("You can only change your own signature");
        target = await findUserById(connection, userId);
      }
    }
    if (!target) return notFound("There is no Floorplan user to save this for");
    await writeUserSignature(connection, target.userId, fields.value, actor.name);
    return { headers: noStore, jsonBody: { jobTitle: fields.value.jobTitle, phone: fields.value.phone, userId: target.userId }, status: 200 };
  } catch (error) {
    context.error("updateMySignature failed:", error instanceof Error ? error.message : error);
    return errorResponse("Could not save your signature", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("updateMySignature", { authLevel: "anonymous", handler: updateMySignature, methods: ["POST"] });
