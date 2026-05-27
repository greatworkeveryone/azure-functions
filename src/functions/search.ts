import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import {
  AppRole,
  errorResponse,
  extractToken,
  requireRole,
  unauthorizedResponse,
} from "../auth";
import { closeConnection, createConnection, executeQuery, SqlRow } from "../db";
import { escapeLikePattern, validateSearchQuery } from "../searchUtils";

export type SearchResultItem = {
  id: number;
  title: string;
  subtitle?: string;
  href: string;
};

export type SearchResponse = {
  tenants: SearchResultItem[];
  jobs: SearchResultItem[];
  keys: SearchResultItem[];
  buildings: SearchResultItem[];
};

type QueryParams = { likeParam: string; prefixParam: string };

const TENANTS_SQL = `
  SELECT TOP 5
    t.TenantId    AS id,
    t.LegalName   AS title,
    b.BuildingName AS subtitle
  FROM dbo.Tenants t
  LEFT JOIN dbo.Buildings b ON b.Id = t.BuildingId
  WHERE t.LegalName    LIKE @q ESCAPE '\\'
     OR t.TradingName  LIKE @q ESCAPE '\\'
  ORDER BY
    CASE WHEN t.LegalName LIKE @prefix ESCAPE '\\' THEN 0 ELSE 1 END,
    t.LegalName
`;

async function queryTenants(
  conn: import("tedious").Connection,
  { likeParam, prefixParam }: QueryParams,
): Promise<SearchResultItem[]> {
  const rows = await executeQuery(conn, TENANTS_SQL, [
    { name: "q",      type: TYPES.NVarChar, value: likeParam },
    { name: "prefix", type: TYPES.NVarChar, value: prefixParam },
  ]);
  return rows.map((r: SqlRow) => ({
    id: r.id as number,
    title: r.title as string,
    subtitle: (r.subtitle as string | null) ?? undefined,
    href: `/tenancy/${r.id}`,
  }));
}

const JOBS_SQL = `
  SELECT TOP 5
    j.JobID   AS id,
    j.Title   AS title,
    CONCAT(j.Status, ' · ', b.BuildingName) AS subtitle
  FROM dbo.Jobs j
  LEFT JOIN dbo.Buildings b ON b.BuildingID = j.BuildingID
  WHERE j.Title LIKE @q ESCAPE '\\'
  ORDER BY
    CASE WHEN j.Title LIKE @prefix ESCAPE '\\' THEN 0 ELSE 1 END,
    j.Title
`;

async function queryJobs(
  conn: import("tedious").Connection,
  { likeParam, prefixParam }: QueryParams,
): Promise<SearchResultItem[]> {
  const rows = await executeQuery(conn, JOBS_SQL, [
    { name: "q",      type: TYPES.NVarChar, value: likeParam },
    { name: "prefix", type: TYPES.NVarChar, value: prefixParam },
  ]);
  return rows.map((r: SqlRow) => ({
    id: r.id as number,
    title: r.title as string,
    subtitle: (r.subtitle as string | null) ?? undefined,
    href: `/jobs?jobId=${r.id}`,
  }));
}

const KEYS_SQL = `
  SELECT TOP 5
    k.Id          AS id,
    k.KeyNumber   AS title,
    CONCAT(k.Level, ' · ', b.BuildingName) AS subtitle
  FROM dbo.[Keys] k
  LEFT JOIN dbo.Buildings b ON b.Id = k.BuildingId
  WHERE k.KeyNumber  LIKE @q ESCAPE '\\'
     OR k.Description LIKE @q ESCAPE '\\'
     OR k.Level       LIKE @q ESCAPE '\\'
  ORDER BY
    CASE WHEN k.KeyNumber LIKE @prefix ESCAPE '\\' THEN 0 ELSE 1 END,
    k.KeyNumber
`;

async function queryKeys(
  conn: import("tedious").Connection,
  { likeParam, prefixParam }: QueryParams,
): Promise<SearchResultItem[]> {
  const rows = await executeQuery(conn, KEYS_SQL, [
    { name: "q",      type: TYPES.NVarChar, value: likeParam },
    { name: "prefix", type: TYPES.NVarChar, value: prefixParam },
  ]);
  return rows.map((r: SqlRow) => ({
    id: r.id as number,
    title: r.title as string,
    subtitle: (r.subtitle as string | null) ?? undefined,
    href: `/keys/${r.id}`,
  }));
}

const BUILDINGS_SQL = `
  SELECT TOP 5
    BuildingID   AS id,
    BuildingName AS title,
    BuildingCode AS subtitle
  FROM dbo.Buildings
  WHERE BuildingName LIKE @q ESCAPE '\\'
     OR BuildingCode LIKE @q ESCAPE '\\'
  ORDER BY
    CASE WHEN BuildingName LIKE @prefix ESCAPE '\\' THEN 0 ELSE 1 END,
    BuildingName
`;

async function queryBuildings(
  conn: import("tedious").Connection,
  { likeParam, prefixParam }: QueryParams,
): Promise<SearchResultItem[]> {
  const rows = await executeQuery(conn, BUILDINGS_SQL, [
    { name: "q",      type: TYPES.NVarChar, value: likeParam },
    { name: "prefix", type: TYPES.NVarChar, value: prefixParam },
  ]);
  return rows.map((r: SqlRow) => ({
    id: r.id as number,
    title: r.title as string,
    subtitle: (r.subtitle as string | null) ?? undefined,
    href: `/tenancy?buildingId=${r.id}`,
  }));
}

export async function search(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.USER]);
  if (denied) return denied;

  const validated = validateSearchQuery(request.query.get("q") ?? undefined);
  if (!validated.ok) {
    return {
      status: 400,
      jsonBody: {
        error:
          validated.reason === "empty"
            ? "Query must not be empty"
            : "Query must be 1–100 chars",
      },
    };
  }

  const escaped = escapeLikePattern(validated.value);
  const params: QueryParams = {
    likeParam: `%${escaped}%`,
    prefixParam: `${escaped}%`,
  };

  let conn;
  try {
    conn = await createConnection(token);
    // tedious connections handle one request at a time; run sequentially.
    const tenants = await queryTenants(conn, params);
    const jobs = await queryJobs(conn, params);
    const keys = await queryKeys(conn, params);
    const buildings = await queryBuildings(conn, params);
    return {
      status: 200,
      jsonBody: { tenants, jobs, keys, buildings } satisfies SearchResponse,
    };
  } catch (err: any) {
    // tedious errors sometimes carry the useful detail on .code / .number /
    // .state rather than .message — log the full object so the func host
    // terminal shows what actually broke.
    context.error("Search failed:", err);
    return errorResponse("Search failed", err);
  } finally {
    if (conn) closeConnection(conn);
  }
}

app.http("search", { methods: ["GET"], authLevel: "anonymous", handler: search });

export { queryTenants, queryJobs, queryKeys, queryBuildings };
