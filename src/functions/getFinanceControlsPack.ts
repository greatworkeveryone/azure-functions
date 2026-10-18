import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { AppRole, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { closeConnection, createRequestConnection, executeQuery } from "../db";
import { financeControlsSnapshot } from "../financeControlsPack";
export async function getFinanceControlsPack(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, [AppRole.CFO, AppRole.DIRECTOR]);
  if (denied) return denied;
  let connection;
  try {
    connection = await createRequestConnection(token);
    const pack = await financeControlsSnapshot(connection);
    const signoffs = await executeQuery(connection, "SELECT TOP (20) SignoffId, PackVersion, ControlsHash, SignedBy, SignedAt, Note FROM dbo.FinanceControlsSignoffs ORDER BY SignoffId DESC");
    const exceptions = await executeQuery(connection, `SELECT Action, COUNT(*) AS EventCount FROM dbo.DecisionLedger
      WHERE OccurredAt >= DATEADD(DAY,-7,SYSUTCDATETIME()) AND IsException=1
      GROUP BY Action`);
    const failures = await executeQuery(connection, `SELECT COUNT(*) AS EventCount FROM dbo.MyobApiLog
      WHERE OccurredAt >= DATEADD(DAY,-7,SYSUTCDATETIME()) AND Method='POST' AND (Phase='error' OR HttpStatus >= 400)`);
    return { status: 200, jsonBody: { ...pack, signoffs, exceptions, myobWriteFailures: Number(failures[0]?.EventCount ?? 0) } };
  } catch (error) { context.error("getFinanceControlsPack", error); return { status: 500, jsonBody: { error: "Could not load the controls pack." } }; }
  finally { if (connection) closeConnection(connection); }
}
app.http("getFinanceControlsPack", { methods: ["GET"], authLevel: "anonymous", handler: getFinanceControlsPack });
