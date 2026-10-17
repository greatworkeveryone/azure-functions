// The shape every "only the CFO may do this" MYOB endpoint shares: a token,
// the myobController capability (role cfo; admin and director refused), a
// parsed body, then the work and its ledger rows in one transaction. Known
// refusals map to their status; anything else is a logged 500.

import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { errorResponse, extractToken, forbiddenResponse, rolesForRequest, unauthorizedResponse } from "./auth";
import { beginTransaction, closeConnection, commitTransaction, createRequestConnection, rollbackTransaction } from "./db";
import { LedgerValidationError, type LedgerActor } from "./ledger";
import { resolveLedgerActor } from "./ledger/actor";
import { isMyobController, MyobControlsError } from "./myob-controls-admin";

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ControllerAction<T> {
  failure: string;
  forbidden: string;
  name: string;
  parse: (body: unknown) => Parsed<T>;
  /** Optional slow step (a MYOB read) run before any transaction is opened. */
  prepare?: (input: T, token: string) => Promise<T>;
  /** Runs inside the transaction; its result is the 200 body. */
  work: (tx: Connection, actor: LedgerActor, input: T) => Promise<unknown>;
}

export async function runControllerAction<T>(
  request: HttpRequest,
  context: InvocationContext,
  action: ControllerAction<T>,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  if (!isMyobController(await rolesForRequest(request))) return forbiddenResponse(action.forbidden);
  const parsed = action.parse(await request.json().catch(() => null));
  if (!parsed.ok) return { jsonBody: { error: parsed.error }, status: 400 };

  let connection: Connection | undefined;
  try {
    const input = action.prepare ? await action.prepare(parsed.value, token) : parsed.value;
    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();
    await beginTransaction(connection);
    try {
      const body = await action.work(connection, actor, input);
      await commitTransaction(connection);
      return { jsonBody: body, status: 200 };
    } catch (error) {
      await rollbackTransaction(connection).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (error instanceof MyobControlsError) return { jsonBody: { error: error.message }, status: error.status };
    if (error instanceof LedgerValidationError) return { jsonBody: { error: error.message }, status: 400 };
    const message = error instanceof Error ? error.message : String(error);
    context.error(`${action.name} failed:`, message);
    return errorResponse(action.failure, message);
  } finally {
    if (connection) closeConnection(connection);
  }
}
