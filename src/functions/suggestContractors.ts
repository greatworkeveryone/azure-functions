// POST /api/suggestContractors  { context, jobId } or { context, buildingId, trade }
//
// Up to five contractors worth asking or assigning for this job, best first, each
// with plain reasons and the state of their certificate of currency. Inactive and
// suspended contractors are never offered; a missing or expired certificate lowers
// a contractor's place and is said so, it never hides or blocks anyone. Logs the
// set, with the exact features, so a later ranker can learn from what is chosen
// (recordContractorSuggestionOutcome). Whoever may request quotes may ask
// (ACTION_ROLES.addQuoteContractor), which includes everyone who may raise a
// purchase order. Test records count only for a test job or an admin with Show
// test data on. Behind the contractorSuggestions flag in the app; the flag is a
// rollout tool, not a gate here. Which ranker answers is CONTRACTOR_RANKER.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { authorizeWrite, badRequest, notFound, readJsonBody } from "../assetRegisterSupport";
import { errorResponse } from "../auth";
import { parseSuggestInput } from "../contractorSuggestions/input";
import { SUGGEST_LIMIT, tooManyRequests } from "../contractorSuggestions/limits";
import { resolveRanker } from "../contractorSuggestions/registry";
import { suggest } from "../contractorSuggestions/suggest";
import { closeConnection, createRequestConnection } from "../db";
import { checkRateLimit } from "../rateLimit";
import { showTestParam } from "../test-data";

export async function suggestContractors(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, ACTION_ROLES.addQuoteContractor.gate);
  if (!auth.ok) return auth.response;
  const limited = checkRateLimit(`suggestContractors:${auth.caller.oid}`, SUGGEST_LIMIT);
  if (!limited.allowed) return tooManyRequests(limited.retryAfterMs);
  const body = await readJsonBody(request);
  if (!body) return badRequest("JSON object required");
  const input = parseSuggestInput(body);
  if (!input.ok) return badRequest(input.error);

  const { fellBack, ranker, requested } = resolveRanker();
  if (fellBack) context.warn(`CONTRACTOR_RANKER "${requested}" is not a registered ranker; using ${ranker.version}`);

  let connection: Connection | undefined;
  try {
    const showTest = await showTestParam(request);
    connection = await createRequestConnection(auth.token);
    const result = await suggest(connection, input.value, auth.caller, { ranker, showTest: showTest.value === true });
    if (!result.ok) return notFound(result.error);
    return { headers: { "Cache-Control": "no-store" }, jsonBody: result.value, status: 200 };
  } catch (error) {
    context.error("suggestContractors failed:", error instanceof Error ? error.message : error);
    return errorResponse("Could not load contractor suggestions", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("suggestContractors", { authLevel: "anonymous", handler: suggestContractors, methods: ["POST"] });
