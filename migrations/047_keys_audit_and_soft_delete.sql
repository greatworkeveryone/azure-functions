-- 047_keys_audit_and_soft_delete.sql
--
-- Adds:
--   • CreatedById / CreatedByName / CreatedAt on dbo.Keys — minimal audit.
--     CreatedAt mirrors DateAdded but stores time-of-day; DateAdded stays
--     for back-compat with existing reports.
--   • IsDeleted / DeletedAt / DeletedById / DeletedByName — soft delete.
--     Mirrors the Jobs archive pattern from migration 041: deleted keys are
--     filtered out of every default view but kept on record so they can be
--     restored. No hard-delete endpoint is ever added.
--
-- Re-runnable.

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Keys') AND name = 'CreatedById'
)
  ALTER TABLE dbo.Keys ADD CreatedById NVARCHAR(255) NULL;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Keys') AND name = 'CreatedByName'
)
  ALTER TABLE dbo.Keys ADD CreatedByName NVARCHAR(255) NULL;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Keys') AND name = 'CreatedAt'
)
  ALTER TABLE dbo.Keys
    ADD CreatedAt DATETIME2 NOT NULL CONSTRAINT DF_Keys_CreatedAt DEFAULT SYSUTCDATETIME();
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Keys') AND name = 'IsDeleted'
)
  ALTER TABLE dbo.Keys
    ADD IsDeleted BIT NOT NULL CONSTRAINT DF_Keys_IsDeleted DEFAULT (0);
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Keys') AND name = 'DeletedAt'
)
  ALTER TABLE dbo.Keys ADD DeletedAt DATETIME2 NULL;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Keys') AND name = 'DeletedById'
)
  ALTER TABLE dbo.Keys ADD DeletedById NVARCHAR(255) NULL;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Keys') AND name = 'DeletedByName'
)
  ALTER TABLE dbo.Keys ADD DeletedByName NVARCHAR(255) NULL;
GO

-- Filtered index for the common `IsDeleted = 0` scan in /getKeys.
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'IX_Keys_Active' AND object_id = OBJECT_ID('dbo.Keys')
)
  CREATE NONCLUSTERED INDEX IX_Keys_Active ON dbo.Keys (BuildingId, KeyNumber)
    WHERE IsDeleted = 0;
GO
