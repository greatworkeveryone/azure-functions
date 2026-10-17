// GET /api/getDecisions   (Decisions & exceptions, PLAN §3.12)
//
//   from, to       YYYY-MM-DD, Darwin calendar days, both inclusive
//   actorUserId    who decided
//   action         an exact code, or a prefix ending in "." (e.g. "schedule.")
//   buildingId, tenantId
//   jobId          the job a decision was in
//   contractorId   the contractor a money decision was for; read from the id the
//                  row carries in `after` or `before`
//   exceptionsOnly true | 1
//   sort           occurredAt (default) | impact, both newest / largest first
//   page, pageSize paging, see ../pagination
//   format         json (default) | csv
//
// JSON: { items: DecisionRow[], total, page, pageSize }. Without page/pageSize
// the first MAX_LIST_ROWS rows come back and `truncated: true` says if more exist.
// CSV: every matching row, no paging; refused rather than silently cut short if
// more than MAX_LIST_ROWS rows match.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { closeConnection, createRequestConnection, executeQuery } from "../db";
import { AppRole, errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { MAX_LIST_ROWS, paginationSqlSuffix, parsePagination } from "../pagination";
import { decisionsCsvFileName, decisionsToCsv } from "../ledger/csv";
import { buildDecisionWhere, parseDecisionFilters } from "../ledger/filters";
import { DECISION_COLUMNS, toDecisionRow } from "../ledger/rows";

const ORDER_BY_OCCURRED_AT = "ORDER BY OccurredAt DESC, LedgerId DESC";
// NULL impact sorts last on a descending order in SQL Server.
const ORDER_BY_IMPACT = "ORDER BY FinancialImpact DESC, OccurredAt DESC, LedgerId DESC";

export async function getDecisions(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  // Directors and the CFO; admin passes through the hierarchy. Mirrors the
  // frontend capability viewDecisions (director, cfo, admin).
  const roleCheck = await requireRole(request, [AppRole.DIRECTOR, AppRole.CFO]);
  if (roleCheck) return roleCheck;

  const parsed = parseDecisionFilters(request.query);
  if (!parsed.ok) return { status: 400, jsonBody: { error: parsed.error } };
  const { filters } = parsed;
  const asCsv = filters.format === "csv";
  const { params, whereSql } = buildDecisionWhere(filters);
  const ORDER_BY = filters.sort === "impact" ? ORDER_BY_IMPACT : ORDER_BY_OCCURRED_AT;

  // A CSV export is the whole filtered set, so it ignores paging.
  const pagination = parsePagination(asCsv ? new URLSearchParams() : request.query);

  let connection;
  try {
    connection = await createRequestConnection(token);

    // One row past the ceiling lets a CSV export notice it would be incomplete.
    const topClause = pagination.active ? "" : `TOP ${asCsv ? MAX_LIST_ROWS + 1 : MAX_LIST_ROWS} `;
    const rows = await executeQuery(
      connection,
      `SELECT ${topClause}${DECISION_COLUMNS}
       FROM dbo.DecisionLedger
       ${whereSql}
       ${ORDER_BY}${paginationSqlSuffix(pagination)}`,
      params,
    );

    if (asCsv) {
      if (rows.length > MAX_LIST_ROWS) {
        return {
          status: 400,
          jsonBody: { error: `More than ${MAX_LIST_ROWS} decisions match. Narrow the dates or filters to export.` },
        };
      }
      return {
        status: 200,
        headers: {
          // The browser can only read Content-Disposition cross-origin if exposed.
          "Access-Control-Expose-Headers": "Content-Disposition",
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="${decisionsCsvFileName(new Date())}"`,
          "Content-Type": "text/csv; charset=utf-8",
        },
        body: decisionsToCsv(rows.map(toDecisionRow)),
      };
    }

    const items = rows.map(toDecisionRow);
    let total = items.length;
    if (pagination.active) {
      const totalRows = await executeQuery(
        connection,
        `SELECT COUNT(*) AS Total FROM dbo.DecisionLedger ${whereSql}`,
        params,
      );
      total = (totalRows[0]?.Total as number | undefined) ?? items.length;
    }
    const truncated = !pagination.active && items.length >= MAX_LIST_ROWS;
    if (truncated) {
      context.warn(`getDecisions: hit MAX_LIST_ROWS ceiling (${MAX_LIST_ROWS}) — caller should paginate`);
    }

    return {
      status: 200,
      jsonBody: {
        items,
        total,
        page: pagination.page,
        pageSize: pagination.active ? pagination.pageSize : items.length,
        ...(truncated ? { truncated: true } : {}),
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("getDecisions failed:", message);
    return errorResponse("Failed to fetch decisions", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getDecisions", { methods: ["GET"], authLevel: "anonymous", handler: getDecisions });
