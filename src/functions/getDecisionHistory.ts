// GET /api/getDecisionHistory?subjectType=job&subjectId=123
//
// The plain-language Decision history on the job modal, tenancy page and PO
// card (PLAN §3.12). Returns the newest 200 ledger rows about one subject:
//   tenancy -> the tenancy's own rows plus any row scoped to that tenant
//   job     -> the job's own rows plus any row scoped to that job (its quotes,
//              invoices, POs and payments)
//   other   -> exactly that subject
// Who may call it depends on the subject; see ledger/historyRoles.ts.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { closeConnection, createRequestConnection, executeQuery, SqlParam } from "../db";
import { errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { historyReadRoles } from "../ledger/historyRoles";
import { DECISION_COLUMNS, toDecisionRow } from "../ledger/rows";

const HISTORY_LIMIT = 200;
const SUBJECT_TYPE = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_SUBJECT_ID_CHARS = 64;
const INT_MAX = 2_147_483_647;

const WHERE_SAME_SUBJECT = "SubjectType = @SubjectType AND SubjectId = @SubjectId";
const WHERE_TENANCY = "(SubjectType = @SubjectType AND SubjectId = @SubjectId) OR TenantId = @ScopeId";
const WHERE_JOB = "(SubjectType = @SubjectType AND SubjectId = @SubjectId) OR JobId = @ScopeId";

export async function getDecisionHistory(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const subjectType = request.query.get("subjectType")?.trim() ?? "";
  if (!SUBJECT_TYPE.test(subjectType)) {
    return { status: 400, jsonBody: { error: "subjectType is required" } };
  }

  // Same audience as the read endpoint of that subject (ledger/historyRoles.ts).
  const roleCheck = await requireRole(request, historyReadRoles(subjectType));
  if (roleCheck) return roleCheck;

  const subjectId = request.query.get("subjectId") ?? "";
  if (!subjectId || subjectId.length > MAX_SUBJECT_ID_CHARS) {
    return { status: 400, jsonBody: { error: "subjectId is required" } };
  }

  const params: SqlParam[] = [
    { name: "SubjectType", type: TYPES.NVarChar, value: subjectType },
    { name: "SubjectId", type: TYPES.NVarChar, value: subjectId },
  ];
  let whereSql = WHERE_SAME_SUBJECT;
  if (subjectType === "tenancy" || subjectType === "job") {
    const scopeId = /^\d{1,10}$/.test(subjectId) ? Number(subjectId) : NaN;
    if (!(scopeId >= 1 && scopeId <= INT_MAX)) {
      return { status: 400, jsonBody: { error: `subjectId must be a whole number for a ${subjectType}` } };
    }
    params.push({ name: "ScopeId", type: TYPES.Int, value: scopeId });
    whereSql = subjectType === "tenancy" ? WHERE_TENANCY : WHERE_JOB;
  }

  let connection;
  try {
    connection = await createRequestConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT TOP ${HISTORY_LIMIT} ${DECISION_COLUMNS}
       FROM dbo.DecisionLedger
       WHERE ${whereSql}
       ORDER BY OccurredAt DESC, LedgerId DESC`,
      params,
    );
    return { status: 200, jsonBody: { items: rows.map(toDecisionRow) } };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("getDecisionHistory failed:", message);
    return errorResponse("Failed to fetch decision history", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getDecisionHistory", { methods: ["GET"], authLevel: "anonymous", handler: getDecisionHistory });
