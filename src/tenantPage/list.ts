// "My requests": the requests this tenancy submitted through its links, newest first, each with a
// status timeline (TR3). Scope is the resolved TenantId only. Staff notes, costs, contractors and
// other people's details never leave: only the fields below are selected.

import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../db";
import { categoryLabel } from "./constants";
import { timelineFor, type Timeline } from "./timeline";

export interface TenantRequestApi {
  category: string;
  categoryLabel: string;
  description: string;
  location: string;
  photoCount: number;
  reference: string;
  requestId: number;
  submittedAt: string;
  timeline: Timeline;
  urgency: string;
}

export const referenceFor = (workRequestId: number): string => `FP-${Math.abs(workRequestId)}`;

const hasIntakeColumn = async (connection: Connection): Promise<boolean> => {
  const [row] = await executeQuery(connection, `SELECT COL_LENGTH('dbo.WorkRequests', 'IntakeState') AS Len`);
  return row?.Len != null;
};

const SELECT_WITH_INTAKE = `SELECT TOP (50) w.WorkRequestID, w.Details, w.ExactLocation, w.Priority, w.Status, w.CreatedAt,
       w.ActualCompletionDate, w.IntakeState AS IntakeState,
       (SELECT COUNT(*) FROM dbo.TenantRequestPhotos p WHERE p.WorkRequestID = w.WorkRequestID AND p.TenantId = w.SourceTenantId) AS PhotoCount,
       w.TenantCategory
  FROM dbo.WorkRequests w
 WHERE w.SourceTenantId = @TenantId AND w.SourceKind = N'tenant_link'
 ORDER BY w.CreatedAt DESC, w.WorkRequestID DESC`;

const SELECT_WITHOUT_INTAKE = `SELECT TOP (50) w.WorkRequestID, w.Details, w.ExactLocation, w.Priority, w.Status, w.CreatedAt,
       w.ActualCompletionDate, CAST(NULL AS NVARCHAR(50)) AS IntakeState,
       (SELECT COUNT(*) FROM dbo.TenantRequestPhotos p WHERE p.WorkRequestID = w.WorkRequestID AND p.TenantId = w.SourceTenantId) AS PhotoCount,
       w.TenantCategory
  FROM dbo.WorkRequests w
 WHERE w.SourceTenantId = @TenantId AND w.SourceKind = N'tenant_link'
 ORDER BY w.CreatedAt DESC, w.WorkRequestID DESC`;

export async function listTenantRequests(connection: Connection, tenantId: number): Promise<TenantRequestApi[]> {
  const rows = await executeQuery(connection, (await hasIntakeColumn(connection)) ? SELECT_WITH_INTAKE : SELECT_WITHOUT_INTAKE, [{ name: "TenantId", type: TYPES.Int, value: tenantId }]);
  return rows.map((row) => {
    const id = Number(row.WorkRequestID);
    const category = typeof row.TenantCategory === "string" ? row.TenantCategory : "other";
    const submitted = row.CreatedAt instanceof Date ? row.CreatedAt : new Date(0);
    return {
      category,
      categoryLabel: categoryLabel(category),
      description: String(row.Details ?? ""),
      location: String(row.ExactLocation ?? ""),
      photoCount: Number(row.PhotoCount ?? 0),
      reference: referenceFor(id),
      requestId: id,
      submittedAt: submitted.toISOString(),
      timeline: timelineFor({ completedAt: row.ActualCompletionDate, intakeState: row.IntakeState, status: row.Status, submittedAt: submitted }),
      urgency: String(row.Priority ?? "").toLowerCase(),
    };
  });
}
