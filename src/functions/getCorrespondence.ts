// GET /api/getCorrespondence?id=<correspondenceId>
//
// A send job: its subject, wording, sender, reply-to and signature as composed, status and counts, each
// recipient's outcome (status, the error code if any, when it went) and the job's event history. Only
// whoever queued it and the managers who approve sends may read it (the handler checks; the gate is
// ACTION_ROLES.viewCorrespondence, and admin, who passes it, reads too). A recipient's merge values are
// not returned.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { AppRole, errorResponse } from "../auth";
import { authorizeActor, badRequest, forbidden, isSendManager, noStore, notFound } from "../comms/actor";
import { readEvents } from "../comms/events";
import { wholeId } from "../comms/request";
import { readJob, readRecipients } from "../comms/store";
import { closeConnection, createRequestConnection } from "../db";

export async function getCorrespondence(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeActor(request, ACTION_ROLES.viewCorrespondence.gate);
  if (!auth.ok) return auth.response;
  const { actor } = auth;
  const id = wholeId(request.query.get("id"));
  if (id === null) return badRequest("id must be a whole number");

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const job = await readJob(connection, id);
    if (!job) return notFound("That send doesn't exist");
    if (job.createdByOid !== actor.oid && !isSendManager(actor.roles) && !actor.roles.includes(AppRole.ADMIN)) return forbidden("You can only open your own sends");
    const [recipients, events] = await Promise.all([readRecipients(connection, id), readEvents(connection, id)]);
    return {
      headers: noStore,
      jsonBody: {
        correspondence: job,
        events,
        recipients: recipients.map(({ mergeValues: _values, ...rest }) => rest),
      },
      status: 200,
    };
  } catch (error) {
    context.error("getCorrespondence failed:", error instanceof Error ? error.message : error);
    return errorResponse("Could not load the send", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getCorrespondence", { authLevel: "anonymous", handler: getCorrespondence, methods: ["GET"] });
