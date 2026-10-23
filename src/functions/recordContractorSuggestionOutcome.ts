// POST /api/recordContractorSuggestionOutcome  { suggestionSetId, jobId?, chosenContractorIds | dismissed }
//
// What the person chose after being shown a set of suggestions: logged against the
// set so a ranker can be judged, and later trained, on real choices. The set must
// exist, be the caller's own and belong to the same job; otherwise 404. A chosen
// contractor who was not suggested is recorded as such with their features as they
// stand now. Only inserts; the same choice sent twice is recorded once. Same roles
// as suggestContractors (ACTION_ROLES.addQuoteContractor).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { authorizeWrite, badRequest, notFound, readJsonBody } from "../assetRegisterSupport";
import { errorResponse } from "../auth";
import { parseOutcomeInput } from "../contractorSuggestions/input";
import { recordOutcome } from "../contractorSuggestions/outcome";
import { closeConnection, createRequestConnection } from "../db";

export async function recordContractorSuggestionOutcome(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, ACTION_ROLES.addQuoteContractor.gate);
  if (!auth.ok) return auth.response;
  const body = await readJsonBody(request);
  if (!body) return badRequest("JSON object required");
  const input = parseOutcomeInput(body);
  if (!input.ok) return badRequest(input.error);

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const result = await recordOutcome(connection, input.value, auth.caller);
    if (!result.ok) return result.status === 404 ? notFound(result.error) : badRequest(result.error);
    if (result.value.featureCaptureFailed) context.warn(`recordContractorSuggestionOutcome: features not captured for set ${input.value.suggestionSetId}`);
    return { headers: { "Cache-Control": "no-store" }, jsonBody: { outcomes: result.value.outcomes, recorded: result.value.recorded }, status: 200 };
  } catch (error) {
    context.error("recordContractorSuggestionOutcome failed:", error instanceof Error ? error.message : error);
    return errorResponse("Could not record the choice", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("recordContractorSuggestionOutcome", {
  authLevel: "anonymous",
  handler: recordContractorSuggestionOutcome,
  methods: ["POST"],
});
