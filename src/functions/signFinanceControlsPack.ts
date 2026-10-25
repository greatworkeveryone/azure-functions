import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { extractToken, rolesForRequest, unauthorizedResponse, userInfoFromToken } from "../auth";
import { beginTransaction, closeConnection, commitTransaction, createRequestConnection, executeQuery, rollbackTransaction } from "../db";
import { financeControlsSnapshot, PACK_VERSION } from "../financeControlsPack";
export async function signFinanceControlsPack(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  let connection; let transaction = false;
  try {
    if (!(await rolesForRequest(request)).includes("cfo")) return { status: 403, jsonBody: { error: "The CFO signs the Accounts controls pack." } };
    const body = await request.json() as Record<string, unknown>;
    if (body.reviewed !== true || typeof body.controlsHash !== "string" || typeof body.note !== "string" || !body.note.trim() || body.note.length > 2000) return { status: 400, jsonBody: { error: "Confirm review of the controls and give a sign-off note (maximum 2,000 characters)." } };
    const actor = userInfoFromToken(token);
    if (!actor?.email) return { status: 403, jsonBody: { error: "Could not identify the signer." } };
    connection = await createRequestConnection(token);
    await beginTransaction(connection); transaction = true;
    const pack = await financeControlsSnapshot(connection);
    if (pack.controlsHash !== body.controlsHash) {
      await rollbackTransaction(connection); transaction = false;
      return { status: 409, jsonBody: { error: "The controls changed since you reviewed them. Reload and review the new pack." } };
    }
    await executeQuery(connection, `INSERT INTO dbo.FinanceControlsSignoffs (PackVersion, ControlsHash, SnapshotJson, SignedBy, Note) VALUES (@Version,@Hash,@Snapshot,@Signer,@Note)`, [
      { name: "Version", type: TYPES.NVarChar, value: PACK_VERSION }, { name: "Hash", type: TYPES.VarChar, value: pack.controlsHash },
      { name: "Snapshot", type: TYPES.NVarChar, value: JSON.stringify(pack.snapshot) }, { name: "Signer", type: TYPES.NVarChar, value: actor.email },
      { name: "Note", type: TYPES.NVarChar, value: body.note.trim() },
    ]);
    await commitTransaction(connection); transaction = false;
    return { status: 200, jsonBody: { ok: true } };
  } catch (error) { if (connection && transaction) await rollbackTransaction(connection).catch(() => undefined); context.error("signFinanceControlsPack", error); return { status: 500, jsonBody: { error: "Could not record sign-off." } }; }
  finally { if (connection) closeConnection(connection); }
}
app.http("signFinanceControlsPack", { methods: ["POST"], authLevel: "anonymous", handler: signFinanceControlsPack });
