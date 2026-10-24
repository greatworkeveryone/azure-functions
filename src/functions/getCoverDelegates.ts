// GET /api/getCoverDelegates[?userId=N]
//
// "Who covers for me": the nominations in force or still to come for the caller (or,
// for their manager, for the person named by userId), the colleagues who could be
// nominated, and the caller's id. A person sees their own and the ones where they are
// the cover; whose nominations a manager may see is checked in nominate.ts.
//
// 200 { nominations, people, selfId, subjectId }
// 400 bad userId; 403 not theirs to see
//
// Gate: OWN_COVER_ROLES (the viewLeave capability): any signed-in staff member.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import { coverErrorResponse, requireCoverCaller } from "../absenceCover/access";
import { coverError } from "../absenceCover/errors";
import { listNominations } from "../absenceCover/nominate";
import { possibleCovers } from "../absenceCover/people";
import { OWN_COVER_ROLES } from "../absenceCover/roles";
import { todayInDarwin } from "../darwinDate";
import { closeConnection, createRequestConnection } from "../db";
import { listActiveUsers } from "../escalation/store";

export async function getCoverDelegates(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, OWN_COVER_ROLES);
  if (denied) return denied;

  let connection;
  try {
    const raw = request.query.get("userId");
    if (raw !== null && !/^\d{1,10}$/.test(raw)) throw coverError.badRequest("userId must be a person id.");
    connection = await createRequestConnection(token);
    const caller = await requireCoverCaller(request, connection);
    const subjectId = raw === null ? caller.userId : Number(raw);
    const nominations = await listNominations(connection, caller, todayInDarwin(), subjectId);
    const people = possibleCovers(await listActiveUsers(connection), subjectId);
    return { headers: { "Cache-Control": "no-store" }, jsonBody: { nominations, people, selfId: caller.userId, subjectId }, status: 200 };
  } catch (error: unknown) {
    return coverErrorResponse(error, context, "getCoverDelegates");
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getCoverDelegates", { methods: ["GET"], authLevel: "anonymous", handler: getCoverDelegates });
