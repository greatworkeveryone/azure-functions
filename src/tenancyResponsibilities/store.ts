// SQL for a tenancy's responsibilities (TR7). Every statement is parameterised; nothing here deletes.

import { TYPES, type Connection } from "tedious";
import { executeQuery, type SqlParam, type SqlRow } from "../db";
import { versionText } from "../tenantLinks/store";
import type { MaintainedBy, ResponsibilityApi, ResponsibilityFields } from "./types";

const iso = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : null);
const p = (name: string, type: SqlParam["type"], value: unknown): SqlParam => ({ name, type, value });
const str = (value: unknown): string | null => (value == null ? null : String(value));

const COLUMNS = `SELECT r.ResponsibilityId, r.TenantId, r.Item, r.Category, r.Location, r.MaintainedBy, r.AssetId, r.ProjectEventId,
       r.DrawingRef, r.Note, r.ArchivedAt, r.ArchivedBy, r.RowVersion,
       (SELECT a.Name FROM dbo.Assets a WHERE a.AssetId = r.AssetId) AS AssetName,
       (SELECT e.Title FROM dbo.MajorEvents e WHERE e.EventId = r.ProjectEventId AND e.Audience = 'operational_staff') AS ProjectTitle`;

export function responsibilityFromRow(row: SqlRow): ResponsibilityApi {
  return {
    archivedAt: iso(row.ArchivedAt),
    archivedBy: str(row.ArchivedBy),
    assetId: row.AssetId == null ? null : Number(row.AssetId),
    assetName: str(row.AssetName),
    category: str(row.Category),
    drawingRef: str(row.DrawingRef),
    item: String(row.Item ?? ""),
    location: str(row.Location),
    maintainedBy: String(row.MaintainedBy) as MaintainedBy,
    note: str(row.Note),
    projectEventId: row.ProjectEventId == null ? null : Number(row.ProjectEventId),
    projectTitle: str(row.ProjectTitle),
    responsibilityId: Number(row.ResponsibilityId),
    rowVersion: versionText(row.RowVersion),
    tenantId: Number(row.TenantId),
  };
}

export async function listResponsibilities(connection: Connection, tenantId: number): Promise<ResponsibilityApi[]> {
  const rows = await executeQuery(
    connection,
    `${COLUMNS} FROM dbo.TenancyResponsibilities r WHERE r.TenantId = @TenantId
      ORDER BY CASE WHEN r.ArchivedAt IS NULL THEN 0 ELSE 1 END, r.Item, r.ResponsibilityId`,
    [p("TenantId", TYPES.Int, tenantId)],
  );
  return rows.map(responsibilityFromRow);
}

export async function readResponsibility(connection: Connection, tenantId: number, id: number, lock = false): Promise<ResponsibilityApi | null> {
  const [row] = await executeQuery(
    connection,
    `${COLUMNS} FROM dbo.TenancyResponsibilities r ${lock ? "WITH (UPDLOCK, HOLDLOCK)" : ""} WHERE r.ResponsibilityId = @Id AND r.TenantId = @TenantId`,
    [p("Id", TYPES.Int, id), p("TenantId", TYPES.Int, tenantId)],
  );
  return row ? responsibilityFromRow(row) : null;
}

const fieldParams = (f: ResponsibilityFields, by: string): SqlParam[] => [
  p("Item", TYPES.NVarChar, f.item),
  p("Category", TYPES.NVarChar, f.category),
  p("Location", TYPES.NVarChar, f.location),
  p("MaintainedBy", TYPES.VarChar, f.maintainedBy),
  p("AssetId", TYPES.Int, f.assetId),
  p("ProjectEventId", TYPES.Int, f.projectEventId),
  p("DrawingRef", TYPES.NVarChar, f.drawingRef),
  p("Note", TYPES.NVarChar, f.note),
  p("By", TYPES.NVarChar, by),
];

export async function insertResponsibility(connection: Connection, tenantId: number, f: ResponsibilityFields, by: string): Promise<number> {
  const [row] = await executeQuery(
    connection,
    `INSERT INTO dbo.TenancyResponsibilities (TenantId, Item, Category, Location, MaintainedBy, AssetId, ProjectEventId, DrawingRef, Note, CreatedBy, UpdatedBy)
     OUTPUT INSERTED.ResponsibilityId
     VALUES (@TenantId, @Item, @Category, @Location, @MaintainedBy, @AssetId, @ProjectEventId, @DrawingRef, @Note, @By, @By)`,
    [p("TenantId", TYPES.Int, tenantId), ...fieldParams(f, by)],
  );
  return Number(row.ResponsibilityId);
}

/** False when the version is stale (or the row is not this tenancy's): the caller answers 409. */
export async function updateResponsibility(connection: Connection, tenantId: number, id: number, f: ResponsibilityFields, version: Buffer, by: string): Promise<boolean> {
  const rows = await executeQuery(
    connection,
    `UPDATE dbo.TenancyResponsibilities SET Item = @Item, Category = @Category, Location = @Location, MaintainedBy = @MaintainedBy,
            AssetId = @AssetId, ProjectEventId = @ProjectEventId, DrawingRef = @DrawingRef, Note = @Note, UpdatedAt = SYSUTCDATETIME(), UpdatedBy = @By
     OUTPUT INSERTED.ResponsibilityId
      WHERE ResponsibilityId = @Id AND TenantId = @TenantId AND RowVersion = @Version`,
    [p("Id", TYPES.Int, id), p("TenantId", TYPES.Int, tenantId), p("Version", TYPES.Binary, version), ...fieldParams(f, by)],
  );
  return rows.length > 0;
}

export async function setResponsibilityArchived(connection: Connection, tenantId: number, id: number, archived: boolean, version: Buffer, by: string): Promise<boolean> {
  const rows = await executeQuery(
    connection,
    `UPDATE dbo.TenancyResponsibilities SET ArchivedAt = CASE WHEN @Archived = 1 THEN SYSUTCDATETIME() ELSE NULL END, ArchivedBy = CASE WHEN @Archived = 1 THEN @By ELSE NULL END,
            UpdatedAt = SYSUTCDATETIME(), UpdatedBy = @By
     OUTPUT INSERTED.ResponsibilityId
      WHERE ResponsibilityId = @Id AND TenantId = @TenantId AND RowVersion = @Version`,
    [p("Id", TYPES.Int, id), p("TenantId", TYPES.Int, tenantId), p("Version", TYPES.Binary, version), p("By", TYPES.NVarChar, by), p("Archived", TYPES.Bit, archived)],
  );
  return rows.length > 0;
}

/** The asset (on the tenancy's building) and the project a write links to must exist; returns a message, or null. */
export async function linkProblem(connection: Connection, buildingId: number | null, f: ResponsibilityFields): Promise<string | null> {
  if (f.assetId !== null) {
    const [asset] = await executeQuery(connection, "SELECT BuildingId FROM dbo.Assets WHERE AssetId = @Id", [p("Id", TYPES.Int, f.assetId)]);
    if (!asset) return "That asset isn't on the register";
    if (buildingId !== null && Number(asset.BuildingId) !== buildingId) return "That asset is in a different building";
  }
  if (f.projectEventId !== null) {
    const [event] = await executeQuery(connection, "SELECT EventClass FROM dbo.MajorEvents WHERE EventId = @Id", [p("Id", TYPES.Int, f.projectEventId)]);
    if (!event || event.EventClass !== "project") return "That project doesn't exist";
  }
  return null;
}
