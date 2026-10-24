// POST /api/cancelCorrespondence  { correspondenceId }
//
// Stops a send: the person who queued it, or a manager, the CFO or a director, may cancel it while it
// is a draft, awaiting approval, queued or still going out. Every recipient still waiting is cancelled and
// the queue claims no more of them; the answer says how many had already gone. Once it has finished it
// can't be cancelled (409). Same roles as sending
// (ACTION_ROLES.sendEmail); the handler adds the creator-or-manager check.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { readJsonBody } from "../assetRegisterSupport";
import { errorResponse } from "../auth";
import { authorizeActor, badRequest, conflict, forbidden, isSendManager, noStore, notFound } from "../comms/actor";
import { cancelJob } from "../comms/decide";
import { findUserByOid } from "../comms/userSignatureStore";
import { unexpectedKey, wholeId } from "../comms/request";
import { readJob } from "../comms/store";
import { closeConnection, createRequestConnection } from "../db";

export async function cancelCorrespondence(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeActor(request, ACTION_ROLES.sendEmail.gate, ACTION_ROLES.sendEmail.refused);
  if (!auth.ok) return auth.response;
  const { actor } = auth;
  const body = await readJsonBody(request);
  if (!body) return badRequest("JSON object required");
  const extra = unexpectedKey(body, ["correspondenceId"]);
  if (extra) return badRequest(extra);
  const id = wholeId(body.correspondenceId);
  if (id === null) return badRequest("correspondenceId must be a whole number");

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const job = await readJob(connection, id);
    if (!job) return notFound("That send doesn't exist");
    if (job.createdByOid !== actor.oid && !isSendManager(actor.roles)) return forbidden("Only the person who queued a send, or a manager, can cancel it");
    const user = await findUserByOid(connection, actor.oid);
    const decided = await cancelJob(connection, job, actor, user?.userId ?? null);
    if (!decided.ok) return conflict(decided.error);
    return { headers: noStore, jsonBody: { correspondenceId: id, sent: decided.sent, status: decided.status, unsent: decided.unsent }, status: 200 };
  } catch (error) {
    context.error("cancelCorrespondence failed:", error instanceof Error ? error.message : error);
    return errorResponse("Could not cancel the send", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("cancelCorrespondence", { authLevel: "anonymous", handler: cancelCorrespondence, methods: ["POST"] });
