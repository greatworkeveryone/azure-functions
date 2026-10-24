// POST /api/extractDocumentFields  { kind: "quote" | "invoice", text, jobId? }
//
// The model step of "Read this document" (SC-AI2). The browser has already read a
// contractor PDF's text layer and run Floorplan's own rules over it; with AI switched
// on it sends the same text here, and gets back the fields the model read so the
// browser can merge them with the rules'. Nothing is saved, approved or sent: the
// answer only prefills a form a person then checks.
//
// Whoever may add a quote or an invoice (ACTION_ROLES.createQuote, which createInvoice
// matches: one gate serves both kinds, and extractDocumentFields.test.ts fails if they
// ever differ). The purpose comes from `kind`, never from the body. The call goes
// through runAi like every other, so it is redacted, capped, rate limited and logged
// (recordType job, recordId the job, or the kind when the form has no job yet).
//
// The answer is 200 whatever the call came to: a refusal (AI off, this kind of document
// not switched on in AI_PURPOSES_ENABLED, rate limited, timed out, an answer that failed
// its checks) is `ok: false` with its typed code and a plain sentence, because the
// browser falls back on its own rules and says so. The one HTTP error is a person
// sending far too many requests, or with two already running: 429 with Retry-After, and
// no log row.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES, type Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { resolveAiActor, runAi, throttledResponse } from "../ai";
import { parseExtractionRequest } from "../ai/extractionRequest";
import { errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { closeConnection, createRequestConnection, executeQuery } from "../db";

const PURPOSES = { invoice: "invoice_extraction", quote: "quote_extraction" } as const;

async function jobExists(connection: Connection, jobId: number): Promise<boolean> {
  const rows = await executeQuery(connection, "SELECT JobID FROM Jobs WHERE JobID = @JobID", [{ name: "JobID", type: TYPES.Int, value: jobId }]);
  return rows.length > 0;
}

export async function extractDocumentFields(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, ACTION_ROLES.createQuote.gate);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { status: 400, jsonBody: { error: "Send a JSON object with kind and text." } };
  }
  const parsed = parseExtractionRequest(body);
  if ("error" in parsed) return { status: 400, jsonBody: { error: parsed.error } };
  const { jobId, kind, text } = parsed.request;

  try {
    let connection: Connection | undefined;
    let actor;
    try {
      connection = await createRequestConnection(token);
      if (jobId !== null && !(await jobExists(connection, jobId))) return { status: 404, jsonBody: { error: "Job not found" } };
      actor = await resolveAiActor(request, token, connection);
    } finally {
      // Given back before the model is called: a slow provider holds no connection.
      if (connection) closeConnection(connection);
    }
    if (!actor) return unauthorizedResponse();

    const result = await runAi({
      actor,
      input: text,
      purpose: PURPOSES[kind],
      recordId: jobId === null ? undefined : String(jobId),
      recordType: jobId === null ? kind : "job",
    });
    const limited = throttledResponse(result);
    if (limited) return limited;
    const meta = { callId: result.meta.callId, latencyMs: result.meta.latencyMs, model: result.meta.model, promptVersion: result.meta.promptVersion };
    return {
      status: 200,
      headers: { "Cache-Control": "no-store" },
      jsonBody: result.ok ? { fields: result.output, kind, meta, ok: true } : { kind, meta, ok: false, refusal: result.refusal },
    };
  } catch (error) {
    context.error("extractDocumentFields failed:", error instanceof Error ? error.message : error);
    return errorResponse("The document could not be read by the AI", error);
  }
}

app.http("extractDocumentFields", { authLevel: "anonymous", handler: extractDocumentFields, methods: ["POST"] });
