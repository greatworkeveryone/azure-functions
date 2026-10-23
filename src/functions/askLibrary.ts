// POST /api/askLibrary { question, passages: [{ id?, title, heading?, text }] }
//
// Ask the Library (SC-AI4): answers a staff question from the passages of RP's own
// procedures that the browser found for it. The browser does the finding (the whole
// library is already loaded there, and it only holds what the person may read); this
// route sends the question and those passages through the AI gateway as the
// library_answer purpose, so the switch, redaction, rate limit, answer checks and
// AiCallLog row all apply. Any signed-in person who can use the Library
// (ACTION_ROLES.viewDocumentation).
//
// The answer is 200 whatever the call came to: "AI is switched off" or "too many
// requests" is an expected state, so it comes back as `ok: false` with its typed code
// and plain sentence, as it does for runAiHealthCheck. The model's reply reaches the
// caller only as sentences with the passage numbers each one cites, every one of which
// is a passage that was sent. Passage ids are the browser's own labels and are ignored.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { resolveAiActor, runAi } from "../ai";
import type { LibraryAnswer } from "../ai/libraryAsk/answer";
import { buildLibraryInput } from "../ai/libraryAsk/input";
import { parseAskLibraryBody } from "../ai/libraryAsk/request";
import { errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { closeConnection, createRequestConnection } from "../db";

export async function askLibrary(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, ACTION_ROLES.viewDocumentation.gate);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { status: 400, jsonBody: { error: "Send the question and passages as JSON." } };
  }
  const parsed = parseAskLibraryBody(body);
  if ("error" in parsed) return { status: 400, jsonBody: { error: parsed.error } };

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

    const result = await runAi<LibraryAnswer>({
      actor,
      input: buildLibraryInput(parsed.question, parsed.passages),
      purpose: "library_answer",
      recordType: "library_question",
    });
    return {
      status: 200,
      headers: { "Cache-Control": "no-store" },
      jsonBody: result.ok ? { answer: result.output, ok: true } : { ok: false, refusal: result.refusal },
    };
  } catch (error) {
    context.error("askLibrary failed:", error instanceof Error ? error.message : error);
    return errorResponse("The library answer could not be produced", error);
  }
}

app.http("askLibrary", { authLevel: "anonymous", handler: askLibrary, methods: ["POST"] });
