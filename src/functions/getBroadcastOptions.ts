// GET /api/getBroadcastOptions
//
// What the broadcast screen offers: buildings with the levels that have an active tenancy, the trades
// contractors are set up for, the staff roles that have people, the approval threshold and who could approve
// a send over it (never the caller, who may not approve their own). Reads only. Managers and directors
// (ACTION_ROLES.sendBroadcast).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { errorResponse } from "../auth";
import { authorizeActor, noStore } from "../comms/actor";
import { loadBroadcastOptions } from "../comms/broadcast/options";
import { closeConnection, createRequestConnection } from "../db";

export async function getBroadcastOptions(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeActor(request, ACTION_ROLES.sendBroadcast.gate);
  if (!auth.ok) return auth.response;

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    return { headers: noStore, jsonBody: await loadBroadcastOptions(connection, auth.actor.oid), status: 200 };
  } catch (error) {
    context.error("getBroadcastOptions failed:", error instanceof Error ? error.message : error);
    return errorResponse("Could not load the broadcast choices", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getBroadcastOptions", { authLevel: "anonymous", handler: getBroadcastOptions, methods: ["GET"] });
