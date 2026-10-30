// The shared prologue of the tenancy-contacts endpoints: rollout flag, connection,
// ledger actor, and a uniform error reply. Staff endpoints only; there is no anonymous one here.

import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { badRequest, errorMessage, readJsonBody } from "../assetRegisterSupport";
import { errorResponse, rolesForRequest, unauthorizedResponse } from "../auth";
import { closeConnection, createRequestConnection } from "../db";
import { isFeatureEnabledForRoles } from "../features/flags";
import { resolveLedgerActor } from "../ledger/actor";
import type { LedgerActor } from "../ledger/types";
import { TENANT_LINKS_FLAG } from "./roles";

export interface StaffContext {
  actor: LedgerActor;
  body: Record<string, unknown>;
  connection: Connection;
}

const notAvailable = (): HttpResponseInit => ({ jsonBody: { error: "Not available" }, status: 404 });

/**
 * Flag, connection and actor, then `work`. The caller (the route) has already passed authorize / authorizeWrite
 * and hands over the token. `write` reads a JSON body; a read passes none.
 */
export async function runStaff(
  request: HttpRequest,
  context: InvocationContext,
  name: string,
  token: string,
  write: boolean,
  work: (ctx: StaffContext) => Promise<HttpResponseInit>,
  flag: string = TENANT_LINKS_FLAG,
): Promise<HttpResponseInit> {
  let body: Record<string, unknown> = {};
  if (write) {
    const parsed = await readJsonBody(request);
    if (!parsed) return badRequest("Request body must be a JSON object");
    body = parsed;
  }
  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(token);
    const callerRoles = await rolesForRequest(request);
    if (!(await isFeatureEnabledForRoles(flag, callerRoles, { connection }))) return notAvailable();
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();
    return await work({ actor, body, connection });
  } catch (error) {
    context.error(`${name} failed:`, errorMessage(error));
    return errorResponse("Could not complete that request", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

export const refusal = (status: number, error: string): HttpResponseInit => ({ jsonBody: { error }, status });
