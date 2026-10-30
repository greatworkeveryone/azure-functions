// The shared prologue of the tenancy-contacts endpoints: role gate, rollout flag, connection,
// ledger actor, and a uniform error reply. Staff endpoints only; there is no anonymous one here.

import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { authorize, authorizeWrite, badRequest, errorMessage, readJsonBody } from "../assetRegisterSupport";
import { errorResponse, rolesForRequest, unauthorizedResponse, type AppRole } from "../auth";
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

/** Gate, flag, connection and actor, then `work`. `write` reads a JSON body; a read passes none. */
export async function runStaff(
  request: HttpRequest,
  context: InvocationContext,
  name: string,
  roles: readonly AppRole[],
  write: boolean,
  work: (ctx: StaffContext) => Promise<HttpResponseInit>,
): Promise<HttpResponseInit> {
  const auth = write ? await authorizeWrite(request, roles) : await authorize(request, roles);
  if (!auth.ok) return auth.response;
  let body: Record<string, unknown> = {};
  if (write) {
    const parsed = await readJsonBody(request);
    if (!parsed) return badRequest("Request body must be a JSON object");
    body = parsed;
  }
  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const callerRoles = await rolesForRequest(request);
    if (!(await isFeatureEnabledForRoles(TENANT_LINKS_FLAG, callerRoles, { connection }))) return notAvailable();
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
