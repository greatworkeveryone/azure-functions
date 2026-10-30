// What a notice needs to know about its job, request and tenancy, read in one query (TR4).

import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../db";

export interface NoticeContext {
  buildingName: string;
  emailOnly: boolean;
  isTestJob: boolean;
  isTestTenancy: boolean;
  jobArchived: boolean;
  reference: string;
  requestEmail: string | null;
  summary: string;
  tenancyArchived: boolean;
  tenantId: number | null;
  tenantName: string;
  workRequestId: number | null;
}

const CONTEXT_SQL = `SELECT j.IsTest, j.IsArchived, j.WorkRequestID, j.TenantID, j.JobCode, j.Category AS JobCategory, j.[Type] AS JobType,
       wr.JobCode AS RequestCode, wr.BuildingName AS RequestBuilding,
       COALESCE(o.ContactEmail, wr.ContactEmail) AS ContactEmail,
       COALESCE(o.Category, wr.Category) AS Category, COALESCE(o.[Type], wr.[Type]) AS RequestType,
       b.BuildingName AS RegisterBuilding,
       t.LegalName, t.TradingName, t.EmailOnly, t.IsTest AS TenantIsTest, t.ArchivedAt AS TenantArchivedAt
  FROM dbo.Jobs j
  LEFT JOIN dbo.WorkRequests wr ON wr.WorkRequestID = j.WorkRequestID
  LEFT JOIN dbo.WorkRequestOverrides o ON o.WorkRequestID = j.WorkRequestID
  LEFT JOIN dbo.Buildings b ON b.BuildingID = j.BuildingID
  LEFT JOIN dbo.Tenants t ON t.TenantId = j.TenantID
 WHERE j.JobID = @JobId`;

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const first = (...values: unknown[]): string => values.map(text).find((value) => value !== "") ?? "";

export async function loadNoticeContext(connection: Connection, jobId: number): Promise<NoticeContext | null> {
  const [row] = await executeQuery(connection, CONTEXT_SQL, [{ name: "JobId", type: TYPES.Int, value: jobId }]);
  if (!row) return null;
  const requestId = row.WorkRequestID == null ? null : Number(row.WorkRequestID);
  return {
    buildingName: first(row.RegisterBuilding, row.RequestBuilding) || "your building",
    emailOnly: row.EmailOnly === true,
    isTestJob: row.IsTest === true,
    isTestTenancy: row.TenantIsTest === true,
    jobArchived: row.IsArchived === true,
    reference: first(row.RequestCode, row.JobCode) || (requestId === null ? "" : `REQ-${requestId}`),
    requestEmail: text(row.ContactEmail) || null,
    summary: first(row.RequestType, row.Category, row.JobType, row.JobCategory) || "your request",
    tenancyArchived: row.TenantArchivedAt != null,
    tenantId: row.TenantID == null ? null : Number(row.TenantID),
    tenantName: first(row.TradingName, row.LegalName),
    workRequestId: requestId,
  };
}
