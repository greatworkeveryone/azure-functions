// POST /api/runAiHealthCheck
//
// Admin → AI activity → "Run a test call" (SC-AI1): sends a fixed, harmless sentence
// through runAi as the echo_test purpose, so an admin can see the switch, the
// provider, the answer checks and the log row all work, without touching a record.
// Admin only (ACTION_ROLES.runAiHealthCheck). Takes no input from the caller.
//
// The answer is 200 whatever the call came to: a refusal (switched off, rate limited,
// timed out...) is the thing being checked, so it is reported as `ok: false` with its
// typed code and plain sentence, never as an HTTP error. The call is logged like any
// other (recordType health_check).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { resolveAiActor, runAi } from "../ai";
import { outcomeFor } from "../ai/refusals";
import { errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { closeConnection, createRequestConnection } from "../db";

const HEALTH_CHECK_INPUT = "Floorplan AI health check";

export async function runAiHealthCheck(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, ACTION_ROLES.runAiHealthCheck.gate);
  if (denied) return denied;

  try {
    let connection: Connection | undefined;
    let actor;
    try {
      connection = await createRequestConnection(token);
      actor = await resolveAiActor(request, token, connection);
    } finally {
      // Given back before the model is called: a slow provider holds no connection.
      if (connection) closeConnection(connection);
    }
    if (!actor) return unauthorizedResponse();

    const result = await runAi({ actor, input: HEALTH_CHECK_INPUT, purpose: "echo_test", recordType: "health_check" });
    return {
      status: 200,
      headers: { "Cache-Control": "no-store" },
      jsonBody: {
        callId: result.meta.callId,
        latencyMs: result.meta.latencyMs,
        model: result.meta.model,
        ok: result.ok,
        outcome: result.ok ? "ok" : outcomeFor(result.refusal.code),
        provider: result.meta.provider,
        refusal: result.ok ? null : result.refusal,
      },
    };
  } catch (error) {
    context.error("runAiHealthCheck failed:", error instanceof Error ? error.message : error);
    return errorResponse("The AI test call could not run", error);
  }
}

app.http("runAiHealthCheck", { authLevel: "anonymous", handler: runAiHealthCheck, methods: ["POST"] });
