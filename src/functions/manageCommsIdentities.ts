// POST /api/manageCommsIdentities  { action: "list" | "create" | "update" | "archive" | "restore", ... }
//
// Admin → Email identities: the reply-to addresses Floorplan may send on behalf of, the roles that
// may use each, and each one's team signature (plain lines, a phone, an email). Admin only
// (ACTION_ROLES.manageEmailIdentities). An edit carries the version it was made from; a stale one is
// a 409 with the identity as it now stands. Identities are archived, never deleted.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { readJsonBody } from "../assetRegisterSupport";
import { errorResponse } from "../auth";
import { authorizeActor, badRequest, conflict, noStore, notFound } from "../comms/actor";
import { parseIdentityInput } from "../comms/identityInput";
import { insertIdentity, isDuplicateAddress, listIdentities, readIdentity, setIdentityArchived, updateIdentity, type WriteResult } from "../comms/identityStore";
import { unexpectedKey, wholeId } from "../comms/request";
import { closeConnection, createRequestConnection } from "../db";

const ACTIONS = ["list", "create", "update", "archive", "restore"] as const;
const VERSION = /^[0-9A-Fa-f]{16}$/;
const DUPLICATE = "There is already an identity with that address";

export async function manageCommsIdentities(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeActor(request, ACTION_ROLES.manageEmailIdentities.gate);
  if (!auth.ok) return auth.response;
  const body = await readJsonBody(request);
  if (!body) return badRequest("JSON object required");
  const action = ACTIONS.find((name) => name === body.action);
  if (!action) return badRequest("action must be list, create, update, archive or restore");
  const by = auth.actor.name;

  let connection: Connection | undefined;
  try {
    if (action === "list") {
      const extra = unexpectedKey(body, ["action", "includeArchived"]);
      if (extra) return badRequest(extra);
      connection = await createRequestConnection(auth.token);
      return { headers: noStore, jsonBody: { identities: await listIdentities(connection, body.includeArchived === true) }, status: 200 };
    }
    if (action === "create") {
      const input = parseIdentityInput(body, ["action"]);
      if (!input.ok) return badRequest(input.error);
      connection = await createRequestConnection(auth.token);
      try {
        const identityId = await insertIdentity(connection, input.value, by);
        return { headers: noStore, jsonBody: { identity: await readIdentity(connection, identityId) }, status: 201 };
      } catch (error) {
        if (isDuplicateAddress(error)) return conflict(DUPLICATE);
        throw error;
      }
    }

    const identityId = wholeId(body.identityId);
    if (identityId === null) return badRequest("identityId must be a whole number");
    if (typeof body.rowVersion !== "string" || !VERSION.test(body.rowVersion)) return badRequest("rowVersion is required: reload and try again");
    const rowVersion = body.rowVersion;
    connection = await createRequestConnection(auth.token);
    let result: WriteResult;
    if (action === "update") {
      const input = parseIdentityInput(body, ["action", "identityId", "rowVersion"]);
      if (!input.ok) return badRequest(input.error);
      try {
        result = await updateIdentity(connection, identityId, rowVersion, input.value, by);
      } catch (error) {
        if (isDuplicateAddress(error)) return conflict(DUPLICATE);
        throw error;
      }
    } else {
      const extra = unexpectedKey(body, ["action", "identityId", "rowVersion"]);
      if (extra) return badRequest(extra);
      try {
        result = await setIdentityArchived(connection, identityId, rowVersion, action === "archive", by);
      } catch (error) {
        if (isDuplicateAddress(error)) return conflict("Another identity now uses that address, so this one can't be restored");
        throw error;
      }
    }
    if (result === "missing") return notFound("That identity no longer exists");
    const identity = await readIdentity(connection, identityId);
    if (result === "stale") return conflict("Someone else changed this identity: reload to see their change", { current: identity });
    return { headers: noStore, jsonBody: { identity }, status: 200 };
  } catch (error) {
    context.error("manageCommsIdentities failed:", error instanceof Error ? error.message : error);
    return errorResponse("Could not save the email identity", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("manageCommsIdentities", { authLevel: "anonymous", handler: manageCommsIdentities, methods: ["POST"] });
