// POST /api/approveCorrespondence  { correspondenceId }
//
// A manager, the CFO or a director approves a large send (more recipients than
// COMMS_APPROVAL_THRESHOLD) so the queue may send it. Never the person who queued it, and never
// admin (ACTION_ROLES.approveEmail). Only a send that is awaiting approval can be approved; the
// change, its event and its ledger row land together.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { readJsonBody } from "../assetRegisterSupport";
import { errorResponse } from "../auth";
import { authorizeActor, badRequest, conflict, forbidden, noStore, notFound } from "../comms/actor";
import { approveJob } from "../comms/decide";
import { findUserByOid } from "../comms/identityStore";
import { unexpectedKey, wholeId } from "../comms/request";
import { readJob } from "../comms/store";
import { closeConnection, createRequestConnection } from "../db";

export async function approveCorrespondence(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeActor(request, ACTION_ROLES.approveEmail.gate, ACTION_ROLES.approveEmail.refused);
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
    if (job.createdByOid === actor.oid) return forbidden("Someone else has to approve a send you queued");
    if (job.status !== "awaiting_approval") return conflict("This send is not waiting for approval");
    const user = await findUserByOid(connection, actor.oid);
    const decided = await approveJob(connection, job, actor, user?.userId ?? null);
    if (!decided.ok) return conflict(decided.error);
    return { headers: noStore, jsonBody: { correspondenceId: id, status: decided.status }, status: 200 };
  } catch (error) {
    context.error("approveCorrespondence failed:", error instanceof Error ? error.message : error);
    return errorResponse("Could not approve the send", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("approveCorrespondence", { authLevel: "anonymous", handler: approveCorrespondence, methods: ["POST"] });
