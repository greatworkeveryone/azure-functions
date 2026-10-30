// GET /api/getEmailCertificateSignals?emailIds=1,2,3
//
// Certificate intake (TR8, PLAN §15): for the Incoming emails on screen, which look like a contractor sending a
// certificate of currency (verified contractor sender, a PDF or image attached, and certificate or cover wording),
// which attachments have already been filed, and who by. Deterministic keyword rules decide; the AI reading of the
// email only adds confidence when AI is on. Emails that are neither are left out. Nothing is filed or sent here.
// Same people as read Incoming (ACTION_ROLES.viewEmailCertificate). Answers 404 while the certificateIntake flag is
// not enabled for the caller, so a hidden feature looks absent.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { readAiConfig } from "../ai";
import { authorizeWrite, badRequest, notFound } from "../assetRegisterSupport";
import { errorResponse, rolesForRequest } from "../auth";
import { acknowledgementEnabled } from "../certificateIntake/config";
import { loadCertificateViews } from "../certificateIntake/load";
import { closeConnection, createRequestConnection } from "../db";
import { isFeatureEnabledForRoles } from "../features/flags";
import { parseEmailIds } from "../inboundTriage/input";
import { READ_LIMIT, tooManyRequests } from "../inboundTriage/limits";
import { checkRateLimit } from "../rateLimit";

export async function getEmailCertificateSignals(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, ACTION_ROLES.viewEmailCertificate.gate);
  if (!auth.ok) return auth.response;
  const limited = checkRateLimit(`getEmailCertificateSignals:${auth.caller.oid}`, READ_LIMIT);
  if (!limited.allowed) return tooManyRequests(limited.retryAfterMs);
  const ids = parseEmailIds(request.query.get("emailIds"));
  if (!ids.ok) return badRequest(ids.error);

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const roles = await rolesForRequest(request);
    if (!(await isFeatureEnabledForRoles("certificateIntake", roles, { connection }))) return notFound("Not available");
    const items = await loadCertificateViews(connection, ids.value, readAiConfig().enabled);
    return { headers: { "Cache-Control": "no-store" }, jsonBody: { acknowledgementAvailable: acknowledgementEnabled(), items }, status: 200 };
  } catch (error) {
    context.error("getEmailCertificateSignals failed:", error instanceof Error ? error.message : error);
    return errorResponse("Could not check these emails for certificates", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getEmailCertificateSignals", { authLevel: "anonymous", handler: getEmailCertificateSignals, methods: ["GET"] });
