import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { AppRole, errorResponse, extractToken, requireRole, unauthorizedResponse, verifiedIdentityFromRequest } from "../auth";
import { closeConnection, createRequestConnection, executeQuery } from "../db";

// ── POST /api/unflagEmail ────────────────────────────────────────────────────
// Body: { EmailID: number }
// Puts an email the AI couldn't read (AIFlaggedForReview = 1, set by the parser
// on low confidence, three failed attempts or a parser 400/422, or by a person)
// back into the Incoming inbox. facilities_manager and above (director and
// admin through requireRole's hierarchy) — the frontend's unflagEmail
// capability mirrors this list. Before this, only the admin reset could, and
// the frontend never called it (DL-34, jobs-flow §0.3).

export async function unflagEmail(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.FACILITIES_APPROVAL]);
  if (denied) return denied;

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  const body = (await request.json().catch(() => null)) as { EmailID?: unknown } | null;
  const emailId = body?.EmailID;
  if (typeof emailId !== "number" || !Number.isInteger(emailId)) {
    return { status: 400, jsonBody: { error: "EmailID (number) required" } };
  }

  let connection;
  try {
    connection = await createRequestConnection(token);
    const rows = await executeQuery(
      connection,
      `UPDATE Emails SET AIFlaggedForReview = 0
       OUTPUT INSERTED.EmailID
       WHERE EmailID = @Id AND AIFlaggedForReview = 1`,
      [{ name: "Id", type: TYPES.Int, value: emailId }],
    );
    if (rows.length === 0) {
      return { status: 404, jsonBody: { error: "No flagged email with that id" } };
    }
    context.log(`unflagEmail: ${identity.name} (${identity.oid}) returned email ${emailId} to the inbox`);
    return { status: 200, jsonBody: { ok: true } };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("unflagEmail failed:", message);
    return errorResponse("Un-flag failed", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("unflagEmail", { authLevel: "anonymous", handler: unflagEmail, methods: ["POST"] });
