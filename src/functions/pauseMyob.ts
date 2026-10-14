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
import { isMyobController, setPaused } from "../myob-controls-admin";
import { parsePause } from "../myob-controls-input";

// POST /api/pauseMyob — "Pause everything": { paused, note, companyFileId? }.
// With no file it pauses (or resumes) every company file. While paused,
// myobRequest refuses every call to that file, reads included. Role cfo only;
// each file changed is ledgered (myob.control_change, pause | resume). Its own
// endpoint so the button works whatever else the panel is doing.

export async function pauseMyob(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  if (!isMyobController(await rolesForRequest(request))) return forbiddenResponse("Only the CFO can pause or resume MYOB");

  const parsed = parsePause(await request.json().catch(() => null));
  if (!parsed.ok) return { jsonBody: { error: parsed.error }, status: 400 };

  let connection;
  try {
    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();
    await beginTransaction(connection);
    try {
      const result = await setPaused(connection, actor, parsed.value);
      await commitTransaction(connection);
      return { jsonBody: { files: result.files, paused: parsed.value.paused }, status: 200 };
    } catch (error) {
      await rollbackTransaction(connection).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (error instanceof LedgerValidationError) return { jsonBody: { error: error.message }, status: 400 };
    const message = error instanceof Error ? error.message : String(error);
    context.error("pauseMyob failed:", message);
    return errorResponse("Failed to pause MYOB", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("pauseMyob", { authLevel: "anonymous", handler: pauseMyob, methods: ["POST"] });
