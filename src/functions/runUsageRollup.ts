// POST /api/runUsageRollup   { from?, to? }   (Darwin days, YYYY-MM-DD; default: the last 7 days)
//
// Runs the usage roll-up now for the days asked, so a screen can be refreshed without waiting for the
// nightly timer (PLAN §14). It writes only UsageDaily, recomputed from the raw rows, and never makes
// a figure smaller. Admin only (ACTION_ROLES.manageUsageAnalytics). Works whether or not tracking is
// switched on, so a day collected before it was switched off can still be rolled up.
//
// 200 { from, to, days, inserted, updated }   400 malformed   401 / 403 role gate

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { ACTION_ROLES } from "../action-roles";
import { errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { closeConnection, createRequestConnection } from "../db";
import { addDays, darwinDay } from "../usage/days";
import { MAX_ROLLUP_DAYS, rollUpDays } from "../usage/rollup";
import { parsePeriod } from "../usage/period";

export async function runUsageRollup(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, ACTION_ROLES.manageUsageAnalytics.gate);
  if (denied) return denied;

  let body: Record<string, unknown> = {};
  try {
    const text = await request.text();
    if (text.trim()) body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { jsonBody: { error: "Send JSON" }, status: 400 };
  }
  const query = new URLSearchParams();
  if (typeof body.from === "string") query.set("from", body.from);
  if (typeof body.to === "string") query.set("to", body.to);
  if (!query.has("from") && !query.has("to")) query.set("days", "7");
  const parsed = parsePeriod(query);
  if ("error" in parsed) return { jsonBody: { error: parsed.error }, status: 400 };
  const { from, to } = parsed.period;
  if (to > darwinDay(new Date()) || from < addDays(darwinDay(new Date()), -MAX_ROLLUP_DAYS)) {
    return { jsonBody: { error: "Choose days from the last year, up to today" }, status: 400 };
  }

  let connection;
  try {
    connection = await createRequestConnection(token);
    const counts = await rollUpDays(connection, from, to);
    return { jsonBody: { from, to, ...counts }, status: 200 };
  } catch (error: unknown) {
    context.error("runUsageRollup failed:", error instanceof Error ? error.message : String(error));
    return errorResponse("Could not roll up usage", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("runUsageRollup", { authLevel: "anonymous", handler: runUsageRollup, methods: ["POST"] });
