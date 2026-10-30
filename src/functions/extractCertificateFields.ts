// POST /api/extractCertificateFields  { text, emailId? }
//
// The model step of "File as certificate" (TR8). The browser has read a contractor certificate's text layer; with AI
// switched on it sends that text here and gets back the fields the model read (type of cover, insurer, policy number,
// cover amount, period of insurance) to prefill the certificate form. Nothing is saved, filed or sent: a person checks
// and edits every field. Same people as may file a certificate (ACTION_ROLES.fileEmailCertificate). The call goes
// through runAi like every other (redacted, capped, rate limited, logged; recordType email, recordId the email).
// The answer is 200 whatever the call came to: a refusal (AI off, purpose not listed in AI_PURPOSES_ENABLED, rate
// limited, an answer that failed its checks) is `ok: false` with a plain sentence, because the form falls back on the
// text rules the browser already ran.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { ACTION_ROLES } from "../action-roles";
import { resolveAiActor, runAi, throttledResponse } from "../ai";
import { CERTIFICATE_MAX_INPUT_CHARS } from "../ai/certificateFields";
import { errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { closeConnection, createRequestConnection } from "../db";

export const CERTIFICATE_PURPOSE = "certificate_extraction";

export async function extractCertificateFields(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, ACTION_ROLES.fileEmailCertificate.gate);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { jsonBody: { error: "Send a JSON object with text." }, status: 400 };
  }
  const fields = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!fields || Object.keys(fields).some((key) => key !== "text" && key !== "emailId")) return { jsonBody: { error: "Only text and emailId are accepted." }, status: 400 };
  if (typeof fields.text !== "string" || fields.text.trim() === "") return { jsonBody: { error: "There is no text to read." }, status: 400 };
  const emailId = fields.emailId;
  if (emailId !== undefined && emailId !== null && (typeof emailId !== "number" || !Number.isInteger(emailId) || emailId < 1 || emailId > 2_147_483_647)) {
    return { jsonBody: { error: "emailId must be a whole number." }, status: 400 };
  }

  try {
    let connection;
    let actor;
    try {
      connection = await createRequestConnection(token);
      actor = await resolveAiActor(request, token, connection);
    } finally {
      // Given back before the model is called: a slow provider holds no connection.
      if (connection) closeConnection(connection);
    }
    if (!actor) return unauthorizedResponse();

    const result = await runAi({
      actor,
      input: fields.text.slice(0, CERTIFICATE_MAX_INPUT_CHARS),
      purpose: CERTIFICATE_PURPOSE,
      recordId: typeof emailId === "number" ? String(emailId) : undefined,
      recordType: typeof emailId === "number" ? "email" : "certificate",
    });
    const limited = throttledResponse(result);
    if (limited) return limited;
    const meta = { callId: result.meta.callId, latencyMs: result.meta.latencyMs, model: result.meta.model, promptVersion: result.meta.promptVersion };
    return {
      headers: { "Cache-Control": "no-store" },
      jsonBody: result.ok ? { fields: result.output, meta, ok: true } : { meta, ok: false, refusal: result.refusal },
      status: 200,
    };
  } catch (error) {
    context.error("extractCertificateFields failed:", error instanceof Error ? error.message : error);
    return errorResponse("The certificate could not be read by the AI", error);
  }
}

app.http("extractCertificateFields", { authLevel: "anonymous", handler: extractCertificateFields, methods: ["POST"] });
