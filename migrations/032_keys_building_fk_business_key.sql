-- Migration 032: Keys.BuildingId now FKs Buildings(BuildingID), not Buildings(Id)
--
-- The original Keys migration (030) referenced Buildings(Id) — the surrogate
-- identity. Every other FK in this schema (Tenants, Jobs, WorkRequests, …)
-- references Buildings(BuildingID), the upstream business key, and so does the
-- frontend's `Building.id` mapping (see useBuildings.ts: `id: row.BuildingID`).
--
-- Inserts from the client therefore failed with FK violations because the value
-- being sent was the BuildingID, not the surrogate Id.
--
-- This migration:
--   1. Drops the old FK (auto-named on initial create — looked up dynamically)
--   2. Translates any existing Keys.BuildingId values from surrogate Id → BuildingID
--   3. Re-adds the FK against Buildings(BuildingID)
--
-- Fully idempotent: can be re-run safely.

SET XACT_ABORT ON;
BEGIN TRANSACTION;

-- 1. Drop the existing FK if it exists (constraint name is auto-generated, so
--    look it up by parent + referenced columns).
DECLARE @fkName SYSNAME;
SELECT @fkName = fk.name
  FROM sys.foreign_keys fk
  JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
  JOIN sys.columns parentCol
    ON parentCol.object_id = fkc.parent_object_id
   AND parentCol.column_id = fkc.parent_column_id
  JOIN sys.columns refCol
    ON refCol.object_id = fkc.referenced_object_id
   AND refCol.column_id = fkc.referenced_column_id
 WHERE fk.parent_object_id = OBJECT_ID('dbo.Keys')
   AND parentCol.name = 'BuildingId'
   AND refCol.name = 'Id';

IF @fkName IS NOT NULL
BEGIN
  DECLARE @sql NVARCHAR(MAX) = N'ALTER TABLE dbo.Keys DROP CONSTRAINT ' + QUOTENAME(@fkName);
  EXEC sp_executesql @sql;
END;

-- 2. Translate any rows whose BuildingId currently points at Buildings.Id over
--    to the matching BuildingID. No-op when there are no rows or when values
--    are already BuildingIDs.
UPDATE k
   SET k.BuildingId = b.BuildingID
  FROM dbo.Keys k
  JOIN dbo.Buildings b ON b.Id = k.BuildingId
 WHERE NOT EXISTS (
         SELECT 1 FROM dbo.Buildings b2 WHERE b2.BuildingID = k.BuildingId
       );

-- 3. Add the new FK against BuildingID (only if not already present).
IF NOT EXISTS (
  SELECT 1
    FROM sys.foreign_keys fk
    JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
    JOIN sys.columns parentCol
      ON parentCol.object_id = fkc.parent_object_id
     AND parentCol.column_id = fkc.parent_column_id
    JOIN sys.columns refCol
      ON refCol.object_id = fkc.referenced_object_id
     AND refCol.column_id = fkc.referenced_column_id
   WHERE fk.parent_object_id = OBJECT_ID('dbo.Keys')
     AND parentCol.name = 'BuildingId'
     AND refCol.name = 'BuildingID'
)
BEGIN
  ALTER TABLE dbo.Keys
    ADD CONSTRAINT FK_Keys_Buildings_BuildingID
    FOREIGN KEY (BuildingId) REFERENCES dbo.Buildings(BuildingID);
END;

COMMIT TRANSACTION;
GO
