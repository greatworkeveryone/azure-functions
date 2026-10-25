import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { extractToken, rolesForRequest, unauthorizedResponse, userInfoFromToken } from "../auth";
import { beginTransaction, closeConnection, commitTransaction, createRequestConnection, executeQuery, rollbackTransaction } from "../db";

// Policy changes require CFO/director authority. Compare the previous value so a
// stale tab cannot silently undo another person's classification.
export async function setProcedureEndorsement(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  let connection;
  let transaction = false;
  try {
    const roles = await rolesForRequest(request);
    if (!roles.some(role => role === "cfo" || role === "director")) return { status: 403, jsonBody: { error: "Only the CFO or a director can classify endorsement authority." } };
    const body = await request.json() as Record<string, unknown>;
    if (typeof body.slug !== "string" || !Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 0 || !["team", "executive"].includes(String(body.authority)) || !["team", "executive"].includes(String(body.expectedAuthority))) {
      return { status: 400, jsonBody: { error: "slug, authority, expectedAuthority and expectedVersion are required." } };
    }
    connection = await createRequestConnection(token);
    await beginTransaction(connection);
    transaction = true;
    const rows = await executeQuery(connection,
      "UPDATE dbo.Procedures SET EndorsementAuthority = @Authority, EndorsementVersion = EndorsementVersion + 1 OUTPUT INSERTED.Slug WHERE Slug = @Slug AND EndorsementAuthority = @Expected AND EndorsementVersion = @ExpectedVersion", [
        { name: "Slug", type: TYPES.NVarChar, value: body.slug },
        { name: "Authority", type: TYPES.NVarChar, value: body.authority },
        { name: "ExpectedVersion", type: TYPES.Int, value: body.expectedVersion },
        { name: "Expected", type: TYPES.NVarChar, value: body.expectedAuthority },
      ]);
    if (!rows.length) {
      await rollbackTransaction(connection); transaction = false;
      return { status: 409, jsonBody: { error: "The procedure changed. Reload before changing its endorsement authority." } };
    }
    const actor = userInfoFromToken(token);
    await executeQuery(connection, `INSERT INTO dbo.ProcedureEndorsementAudit (Slug, PreviousAuthority, Authority, ChangedBy) VALUES (@Slug,@Previous,@Authority,@Actor)`, [
      { name: "Slug", type: TYPES.NVarChar, value: body.slug },
      { name: "Previous", type: TYPES.NVarChar, value: body.expectedAuthority },
      { name: "Authority", type: TYPES.NVarChar, value: body.authority },
      { name: "Actor", type: TYPES.NVarChar, value: actor?.email ?? actor?.name ?? "Unknown" },
    ]);
    await commitTransaction(connection); transaction = false;
    return { status: 200, jsonBody: { ok: true } };
  } catch (error) {
    if (connection && transaction) await rollbackTransaction(connection).catch(() => undefined);
    context.error("setProcedureEndorsement failed", error);
    return { status: 500, jsonBody: { error: "Could not change endorsement authority." } };
  } finally { if (connection) closeConnection(connection); }
}
app.http("setProcedureEndorsement", { methods: ["POST"], authLevel: "anonymous", handler: setProcedureEndorsement });
