// GET /api/listCorrespondence?kind=broadcast|letter&limit=<1-100>
//
// Sends, newest first, with status and counts (not the wording or each recipient: getCorrespondence gives
// those). Your own sends; the managers who approve sends and admin see everyone's. Test sends to yourself
// are a different kind and never listed. Reads only (ACTION_ROLES.viewCorrespondence).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { AppRole, errorResponse } from "../auth";
import { authorizeActor, badRequest, isSendManager, noStore } from "../comms/actor";
import { LIST_KINDS, listJobs } from "../comms/listJobs";
import { closeConnection, createRequestConnection } from "../db";

export async function listCorrespondence(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeActor(request, ACTION_ROLES.viewCorrespondence.gate);
  if (!auth.ok) return auth.response;
  const { actor } = auth;
  const kind = request.query.get("kind") ?? "broadcast";
  if (!(LIST_KINDS as readonly string[]).includes(kind)) return badRequest("kind must be broadcast or letter");
  const limitText = request.query.get("limit");
  const limit = limitText === null ? 50 : /^\d{1,3}$/.test(limitText) ? Number(limitText) : 0;
  if (limit < 1 || limit > 100) return badRequest("limit must be 1 to 100");

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const everyone = isSendManager(actor.roles) || actor.roles.includes(AppRole.ADMIN);
    const items = await listJobs(connection, { kind: kind as (typeof LIST_KINDS)[number], limit, oid: everyone ? null : actor.oid });
    return { headers: noStore, jsonBody: { items }, status: 200 };
  } catch (error) {
    context.error("listCorrespondence failed:", error instanceof Error ? error.message : error);
    return errorResponse("Could not load the sends", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("listCorrespondence", { authLevel: "anonymous", handler: listCorrespondence, methods: ["GET"] });
