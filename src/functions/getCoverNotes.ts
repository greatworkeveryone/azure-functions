// GET /api/getCoverNotes?jobIds=1,2,3
//
// For the jobs a screen is showing, who is covering and for whom: "Covered by Y while X is
// away until DD/MM". A job has a note only while it is still with the cover it was handed
// to and the absence has not ended. At most 100 ids. Read-only.
//
// 200 { notes: [{ itemId, coverName, awayName, returnDate }] }
// 400 bad ids
//
// Gate: the jobs read gate (frontend capability viewJobs).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { ACTION_ROLES } from "../action-roles";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import { coverErrorResponse } from "../absenceCover/access";
import { coverError } from "../absenceCover/errors";
import { loadJobCoverNotes, MAX_NOTE_IDS } from "../absenceCover/notes";
import { todayInDarwin } from "../darwinDate";
import { closeConnection, createRequestConnection } from "../db";

export async function getCoverNotes(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, ACTION_ROLES.viewJobs.gate);
  if (denied) return denied;

  let connection;
  try {
    const raw = request.query.get("jobIds") ?? "";
    const ids = raw === "" ? [] : raw.split(",").map((part) => part.trim());
    if (ids.length > MAX_NOTE_IDS || ids.some((id) => !/^\d{1,10}$/.test(id))) {
      throw coverError.badRequest(`Send up to ${MAX_NOTE_IDS} job ids, separated by commas.`);
    }
    connection = await createRequestConnection(token);
    const notes = await loadJobCoverNotes(connection, [...new Set(ids.map(Number))], todayInDarwin());
    return { headers: { "Cache-Control": "no-store" }, jsonBody: { notes }, status: 200 };
  } catch (error: unknown) {
    return coverErrorResponse(error, context, "getCoverNotes");
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getCoverNotes", { methods: ["GET"], authLevel: "anonymous", handler: getCoverNotes });
