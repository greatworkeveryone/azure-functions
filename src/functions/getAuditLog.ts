import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { authorize, badRequest } from "../assetRegisterSupport";
import { rolesForRequest } from "../auth";
import {
  AUDIT_AREAS,
  AUDIT_COLUMNS,
  AUDIT_READ_ROLES,
  AUDIT_UNION_SQL,
  OPERATIONAL_AUDIT_ACTIONS,
  fullAuditAccess,
} from "../auditLog";
import { darwinDayStartUtc, darwinNextDayStartUtc, parseDarwinDate } from "../ledger/darwinTime";
import { closeConnection, createRequestConnection, executeQuery, type SqlParam } from "../db";
import { showTestParam } from "../test-data";
export async function getAuditLog(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const auth = await authorize(request, AUDIT_READ_ROLES);
  if (!auth.ok) return auth.response;
  const full = fullAuditAccess(await rolesForRequest(request));
  const page = Number(request.query.get("page") ?? 1),
    area = request.query.get("area") ?? "",
    search = (request.query.get("search") ?? "").trim(),
    building = request.query.get("buildingId"),
    from = request.query.get("from"),
    to = request.query.get("to");
  if (
    !Number.isInteger(page) ||
    page < 1 ||
    page > 1000000 ||
    search.length > 100 ||
    (area && !AUDIT_AREAS.some((value) => value === area)) ||
    (building !== null &&
      (!Number.isInteger(Number(building)) ||
        !Number(building) ||
        Math.abs(Number(building)) > 2147483647)) ||
    request.query.has("format")
  )
    return badRequest("Invalid audit filters");
  const fromDay = from ? parseDarwinDate(from) : null,
    toDay = to ? parseDarwinDate(to) : null;
  if ((from && !fromDay) || (to && !toDay) || (from && to && from > to))
    return badRequest("Choose valid dates in order");
  const params: SqlParam[] = [
    { name: "Full", type: TYPES.Bit, value: full },
    { name: "OperationalActions", type: TYPES.NVarChar, value: JSON.stringify(OPERATIONAL_AUDIT_ACTIONS) },
    await showTestParam(request),
    { name: "Offset", type: TYPES.Int, value: (page - 1) * 50 },
  ];
  const predicates: string[] = [];
  if (area) {
    predicates.push("Area=@Area");
    params.push({ name: "Area", type: TYPES.NVarChar, value: area });
  }
  if (building !== null) {
    predicates.push("BuildingId=@Building");
    params.push({ name: "Building", type: TYPES.Int, value: Number(building) });
  }
  if (fromDay) {
    predicates.push("OccurredAt>=@From");
    params.push({ name: "From", type: TYPES.DateTime2, value: darwinDayStartUtc(fromDay) });
  }
  if (toDay) {
    predicates.push("OccurredAt<@To");
    params.push({ name: "To", type: TYPES.DateTime2, value: darwinNextDayStartUtc(toDay) });
  }
  if (search) {
    predicates.push("(ActorName LIKE @Search ESCAPE '\\' OR Action LIKE @Search ESCAPE '\\')");
    params.push({
      name: "Search",
      type: TYPES.NVarChar,
      value: `%${search.replace(/[\\%_[]/g, (character) => `\\${character}`)}%`,
    });
  }
  const WHERE_SQL = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
  let connection;
  try {
    connection = await createRequestConnection(auth.token);
    const rows = await executeQuery(
      connection,
      `WITH AuditFeed AS (${AUDIT_UNION_SQL}) SELECT ${AUDIT_COLUMNS} FROM AuditFeed ${WHERE_SQL} ORDER BY OccurredAt DESC,AuditKey DESC OFFSET @Offset ROWS FETCH NEXT 50 ROWS ONLY`,
      params,
    );
    const count = await executeQuery(
      connection,
      `WITH AuditFeed AS (${AUDIT_UNION_SQL}) SELECT COUNT_BIG(*) AS Total FROM AuditFeed ${WHERE_SQL}`,
      params,
    );
    return {
      status: 200,
      headers: { "Cache-Control": "no-store" },
      jsonBody: {
        scope: full ? "all" : "facilities",
        page,
        pageSize: 50,
        total: Number(count[0]?.Total ?? 0),
        items: rows.map((row) => ({
          id: row.AuditKey,
          occurredAt: row.OccurredAt instanceof Date ? row.OccurredAt.toISOString() : row.OccurredAt,
          actor: row.ActorName,
          action: row.Action,
          area: row.Area,
          subjectType: row.SubjectType,
          subjectId: row.SubjectId,
          buildingId: row.BuildingId ?? null,
          jobId: row.JobId ?? null,
        })),
      },
    };
  } catch (error) {
    context.error("Audit log read failed", error);
    return { status: 500, jsonBody: { error: "Could not load the audit log" } };
  } finally {
    if (connection) closeConnection(connection);
  }
}
app.http("getAuditLog", { methods: ["GET"], authLevel: "anonymous", handler: getAuditLog });
