// GET /api/getAiStatus
//
// Whether the AI gateway is switched on, which provider and model it points at, which
// purposes it has, and which of those are switched on (AI_PURPOSES_ENABLED) (SC-AI1).
// Any signed-in user: staff are told whether an AI
// feature will answer before they try it. It reads settings only: no database, no
// call to any model, and nothing secret (no endpoint URL, no key). With AI_ENABLED
// unset it says enabled: false, and every AI endpoint refuses.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { isConfigured, listPurposeIds, readAiConfig } from "../ai";
import { AppRole, errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";

export async function getAiStatus(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, [AppRole.USER]);
  if (denied) return denied;

  try {
    const config = readAiConfig();
    const purposes = listPurposeIds();
    return {
      status: 200,
      headers: { "Cache-Control": "no-store" },
      jsonBody: {
        configured: isConfigured(config),
        enabled: config.enabled,
        enabledPurposes: purposes.filter((id) => config.enabledPurposes.includes(id)),
        model: config.provider === "mock" ? "mock" : config.model,
        provider: config.provider.slice(0, 40),
        purposes,
      },
    };
  } catch (error) {
    context.error("getAiStatus failed:", error instanceof Error ? error.message : error);
    return errorResponse("Could not read the AI status", error);
  }
}

app.http("getAiStatus", { authLevel: "anonymous", handler: getAiStatus, methods: ["GET"] });
