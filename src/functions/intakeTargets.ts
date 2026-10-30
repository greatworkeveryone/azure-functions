// GET  /api/getIntakeTargets   the response targets, one per priority (hours, or null for none)
// POST /api/setIntakeTargets   { targets: { High: 4, Low: null } }  set or clear some of them
//
// How many business hours Facilities promises to acknowledge a request within (TR1, PLAN §15, question Q-T1).
// Unset means no clock and no escalation. Reads: ACTION_ROLES.viewRequestIntake. Writes: ACTION_ROLES.setIntakeTargets
// (the facilities manager and above), each change ledgered. Setting a target never reaches back to requests that
// arrived before it was set (src/intake/overdue.ts).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { authorizeWrite, inTransaction, readJsonBody, txOk } from "../assetRegisterSupport";
import { errorResponse } from "../auth";
import { authorizeActor, badRequest, noStore } from "../comms/actor";
import { findUserByOid } from "../comms/userSignatureStore";
import { closeConnection, createRequestConnection } from "../db";
import { parseTargets, readTargets, writeTargets } from "../intake/targets";
import { record } from "../ledger";
import { ledgerUserActor } from "../ledger/actor";
import { checkRateLimit } from "../rateLimit";

export async function getIntakeTargets(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, ACTION_ROLES.viewRequestIntake.gate);
  if (!auth.ok) return auth.response;
  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    return { headers: noStore, jsonBody: { targets: await readTargets(connection) }, status: 200 };
  } catch (error) {
    context.error("getIntakeTargets failed:", error instanceof Error ? error.message : error);
    return errorResponse("Could not load the response targets", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

export async function setIntakeTargets(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeActor(request, ACTION_ROLES.setIntakeTargets.gate);
  if (!auth.ok) return auth.response;
  const { actor } = auth;
  const limited = checkRateLimit(`setIntakeTargets:${actor.oid}`, { limit: 20 });
  if (!limited.allowed) return { headers: { "Retry-After": String(Math.ceil(limited.retryAfterMs / 1000)) }, jsonBody: { error: "Too many changes, try again shortly" }, status: 429 };
  const body = await readJsonBody(request);
  if (!body) return badRequest("JSON object required");
  const parsed = parseTargets(body);
  if (!parsed.ok) return badRequest(parsed.error);

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const before = await readTargets(connection);
    const user = await findUserByOid(connection, actor.oid);
    const result = await inTransaction<string[]>(connection, async () => {
      const changed = await writeTargets(connection as Connection, parsed.value, actor.name);
      if (changed.length > 0) {
        await record(connection as Connection, {
          action: "work_request.set_targets",
          actor: ledgerUserActor({ name: actor.name, roles: actor.roles, userId: user?.userId ?? null }),
          after: Object.fromEntries(changed.map((priority) => [priority, parsed.value[priority] ?? null])),
          before: Object.fromEntries(changed.map((priority) => [priority, before.find((target) => target.priority === priority)?.hours ?? null])),
          subject: { id: "targets", type: "work_request" },
        });
      }
      return txOk(changed);
    });
    if (!result.ok) return result.response;
    return { headers: noStore, jsonBody: { changed: result.value, targets: await readTargets(connection) }, status: 200 };
  } catch (error) {
    context.error("setIntakeTargets failed:", error instanceof Error ? error.message : error);
    return errorResponse("Could not save the response targets", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getIntakeTargets", { authLevel: "anonymous", handler: getIntakeTargets, methods: ["GET"] });
app.http("setIntakeTargets", { authLevel: "anonymous", handler: setIntakeTargets, methods: ["POST"] });
