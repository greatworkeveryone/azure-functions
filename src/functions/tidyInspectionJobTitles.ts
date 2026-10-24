// POST /api/tidyInspectionJobTitles { titles: [{ title, findings?: string[] }] }
//
// Smart inspection job lists (SC-AI6): when staff raise jobs from an inspection, Floorplan's
// rules group the findings into jobs and draft a title for each; with AI on, this rewords
// those titles. The browser sends the titles it is showing and the findings each job was
// made from; this route sends them through the AI gateway as the inspection_job_titles
// purpose, so the switch, redaction, rate limit, answer checks and AiCallLog row all apply.
// Whoever may raise jobs from an inspection may ask (ACTION_ROLES.editInspections).
//
// The answer is 200 whatever the call came to: "AI is switched off", "not switched on for
// this" or "too many requests in a minute" is an expected state, so it comes back as
// `ok: false` with its typed code and plain sentence, as it does for askLibrary. The one
// HTTP error is a person sending far too many requests, or with two already running: 429
// with Retry-After, and no log row. The purpose has to be listed in AI_PURPOSES_ENABLED as
// well as AI_ENABLED being on. The model's reply reaches the caller only as one plain title
// per job, in the order sent. It cannot add, drop or reorder a job, and it touches no
// record: nothing is saved here.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { resolveAiActor, runAi, throttledResponse } from "../ai";
import { buildTitlesInput } from "../ai/inspectionTitles/input";
import { parseTidyTitlesBody } from "../ai/inspectionTitles/request";
import type { JobTitles } from "../ai/inspectionTitles/validate";
import { errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { closeConnection, createRequestConnection } from "../db";

export async function tidyInspectionJobTitles(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, ACTION_ROLES.editInspections.gate);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { status: 400, jsonBody: { error: "Send the job titles as JSON." } };
  }
  const parsed = parseTidyTitlesBody(body);
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

    const result = await runAi<JobTitles>({
      actor,
      input: buildTitlesInput(parsed.jobs),
      purpose: "inspection_job_titles",
      recordType: "inspection_job_titles",
    });
    const limited = throttledResponse(result);
    if (limited) return limited;
    return {
      status: 200,
      headers: { "Cache-Control": "no-store" },
      jsonBody: result.ok ? { ok: true, titles: result.output.titles } : { ok: false, refusal: result.refusal },
    };
  } catch (error) {
    context.error("tidyInspectionJobTitles failed:", error instanceof Error ? error.message : error);
    return errorResponse("The titles could not be tidied", error);
  }
}

app.http("tidyInspectionJobTitles", { authLevel: "anonymous", handler: tidyInspectionJobTitles, methods: ["POST"] });
