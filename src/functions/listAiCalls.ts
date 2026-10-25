// GET /api/listAiCalls?purpose&outcome&actor&from&to&page&pageSize
//
// Admin → AI activity (SC-AI1): the log of every AI call, newest first, one page at a
// time. Filters: purpose (an id), outcome (ok, refused, failed), actor (part of a
// name or email), from and to (Darwin days, YYYY-MM-DD). Reads only, and never the
// stored text or the input hash. Admin and directors (ACTION_ROLES.viewAiActivity).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { parseAiCallQuery, queryAiCalls } from "../ai/callQuery";
import { errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { closeConnection, createRequestConnection } from "../db";

export async function listAiCalls(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, ACTION_ROLES.viewAiActivity.gate);
  if (denied) return denied;

  const parsed = parseAiCallQuery(request.query);
  if ("error" in parsed) return { status: 400, jsonBody: { error: parsed.error } };

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(token);
    const { items, total } = await queryAiCalls(connection, parsed.filters, parsed.page);
    return {
      status: 200,
      headers: { "Cache-Control": "no-store" },
      jsonBody: { items, page: parsed.page.page, pageSize: parsed.page.pageSize, total },
    };
  } catch (error) {
    context.error("listAiCalls failed:", error instanceof Error ? error.message : error);
    return errorResponse("Could not load the AI activity", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("listAiCalls", { authLevel: "anonymous", handler: listAiCalls, methods: ["GET"] });
