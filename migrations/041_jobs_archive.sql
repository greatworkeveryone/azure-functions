-- 041_jobs_archive.sql
--
-- Adds soft-archive columns to dbo.Jobs. Archive replaces hard delete:
-- archived jobs are filtered out of every default Jobs view but kept on
-- record so they can be restored. The /deleteJob endpoint is being removed
-- in the same change set; archive is the only out-of-active path now.
--
--   IsArchived BIT      — flag, indexed for the default `IsArchived = 0`
--                         filter on /getJobs.
--   ArchivedAt DATETIME — UTC timestamp when archived (null when active).
--   ArchivedBy NVARCHAR — caller name from the JWT, mirrors CreatedBy.
--
-- Re-runnable.

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'IsArchived'
)
  ALTER TABLE dbo.Jobs ADD IsArchived BIT NOT NULL CONSTRAINT DF_Jobs_IsArchived DEFAULT (0);
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'ArchivedAt'
)
  ALTER TABLE dbo.Jobs ADD ArchivedAt DATETIME2 NULL;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'ArchivedBy'
)
  ALTER TABLE dbo.Jobs ADD ArchivedBy NVARCHAR(255) NULL;
GO

-- Filter index: every default jobs query starts with `IsArchived = 0`, so a
-- filtered nonclustered index on the active rows keeps the scan tight.
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'IX_Jobs_Active' AND object_id = OBJECT_ID('dbo.Jobs')
)
  CREATE NONCLUSTERED INDEX IX_Jobs_Active ON dbo.Jobs (LastModifiedDate DESC)
    WHERE IsArchived = 0;
GO
