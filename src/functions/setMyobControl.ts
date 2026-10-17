import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import {
  beginTransaction,
  closeConnection,
  commitTransaction,
  createRequestConnection,
  rollbackTransaction,
} from "../db";
import { errorResponse, extractToken, forbiddenResponse, rolesForRequest, unauthorizedResponse } from "../auth";
import { LedgerValidationError } from "../ledger";
import { resolveLedgerActor } from "../ledger/actor";
import { changeControl, isMyobController, MyobControlsError } from "../myob-controls-admin";
import { parseControlChange } from "../myob-controls-input";

// POST /api/setMyobControl — the CFO changes one MYOB control for one company
// file: { companyFileId, operation, enabled?, dryRun?, dailyCap?,
// requireReview?, note, expectedRowVersion }. Role cfo only (the
// myobController capability; admin and director are refused). The change and
// its myob.control_change ledger row commit together; a stale version is 409.

export async function setMyobControl(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  if (!isMyobController(await rolesForRequest(request))) return forbiddenResponse("Only the CFO can change MYOB controls");

  const parsed = parseControlChange(await request.json().catch(() => null));
  if (!parsed.ok) return { jsonBody: { error: parsed.error }, status: 400 };

  let connection;
  try {
    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();
    await beginTransaction(connection);
    try {
      const result = await changeControl(connection, actor, parsed.value);
      await commitTransaction(connection);
      return { jsonBody: { changed: result.changed, control: result.row, seeded: result.seeded }, status: 200 };
    } catch (error) {
      await rollbackTransaction(connection).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (error instanceof MyobControlsError) return { jsonBody: { error: error.message }, status: error.status };
    if (error instanceof LedgerValidationError) return { jsonBody: { error: error.message }, status: 400 };
    const message = error instanceof Error ? error.message : String(error);
    context.error("setMyobControl failed:", message);
    return errorResponse("Failed to change the MYOB control", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("setMyobControl", { authLevel: "anonymous", handler: setMyobControl, methods: ["POST"] });
