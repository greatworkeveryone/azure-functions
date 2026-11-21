// GET /api/getMyObligations   (one inbox, audit 5.4)
//
// One list for the caller: what is waiting on them (group decide: an approval or decision only they or their role
// can give; group do: work that is theirs to carry out) and what they are waiting on (group waiting: things they
// asked for or sent on, with who has them). Every count in the app that says "waiting on me" is totals.decide +
// totals.do from this answer.
//
// 200 { items, totals, more, unavailable, chasing, generatedAt }
//   items        per source and group at most PER_SOURCE_CAP rows, oldest first; `more` counts what the cap left out
//   unavailable  sources that could not be read this time: the list is then incomplete, never "nothing waiting"
//   chasing      whether the sweep is live (only then may a row promise a reminder)
//
// Gate: any signed-in role. The scope is the caller, taken from the token, never from the request. Reads only.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { AppRole, extractToken, requireRole, rolesForRequest, unauthorizedResponse, verifiedIdentityFromRequest } from "../auth";
import { closeConnection, createRequestConnection, executeQuery } from "../db";
import { TYPES } from "tedious";
import { chasingOn } from "../escalation/config";
import { deriveObligations, loadObligations, makeViewer } from "../obligations";

export async function getMyObligations(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, [AppRole.USER]);
  if (denied) return denied;

  let connection;
  try {
    const identity = await verifiedIdentityFromRequest(request);
    if (!identity) return unauthorizedResponse();
    const roles = await rolesForRequest(request);
    connection = await createRequestConnection(token);
    const me = await executeQuery(connection, `SELECT UserID FROM dbo.AppUsers WHERE EntraOid = @Oid AND IsActive = 1`, [{ name: "Oid", type: TYPES.NVarChar, value: identity.oid }]);
    const viewer = makeViewer({ email: identity.email, name: identity.name, oid: identity.oid, roles, userId: me[0]?.UserID == null ? null : Number(me[0].UserID) });
    const loaded = await loadObligations(connection);
    const derived = deriveObligations(loaded.sources, viewer, loaded.context, loaded.unavailable);
    return {
      headers: { "Cache-Control": "no-store" },
      jsonBody: { chasing: chasingOn(), generatedAt: loaded.context.now.toISOString(), ...derived },
      status: 200,
    };
  } catch (error: unknown) {
    context.error("getMyObligations failed:", error instanceof Error ? error.message : error);
    return { jsonBody: { error: "Couldn't read what is waiting on you. Nothing has been lost; try again." }, status: 500 };
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getMyObligations", { authLevel: "anonymous", handler: getMyObligations, methods: ["GET"] });
