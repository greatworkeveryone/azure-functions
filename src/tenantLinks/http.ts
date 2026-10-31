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
  /** The caller's Floorplan roles, for per-purpose checks. */
  roles: string[];
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
  /** The rollout flag that must be on for the caller; null for settings that are not rolled out behind a flag. */
  flag: string | null = TENANT_LINKS_FLAG,
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
    if (flag !== null && !(await isFeatureEnabledForRoles(flag, callerRoles, { connection }))) return notAvailable();
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();
    return await work({ actor, body, connection, roles: callerRoles });
  } catch (error) {
    context.error(`${name} failed:`, errorMessage(error));
    return errorResponse("Could not complete that request", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

export const refusal = (status: number, error: string): HttpResponseInit => ({ jsonBody: { error }, status });
