-- 042_jobs_parts_to_stalled.sql
--
-- "Parts" is being collapsed into "Stalled" with a captured reason. The UI
-- removes Parts as a top-level bucket and as a status option; jobs waiting
-- on parts now flow through the Stalled bucket with StalledReason='Waiting
-- on parts'.
--
-- This migration:
--   1. Adds dbo.Jobs.StalledReason (NVARCHAR) — the new captured reason for
--      any stalled job, populated by the stalled-reason dialog. Cleared when
--      a job is un-stalled.
--   2. Migrates any existing Status='Parts' rows to Status='Stalled',
--      IsStalled=1, StalledReason='Waiting on parts' so the data lines up
--      with the new shape.
--   3. Writes a JobEvents 'status_changed' row per migrated job so history
--      reflects the transition (one-time, attributed to 'system').
--
-- Re-runnable.

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'StalledReason'
)
  ALTER TABLE dbo.Jobs ADD StalledReason NVARCHAR(100) NULL;
GO

-- Capture the rows we're about to migrate so we can log events for them.
IF EXISTS (SELECT 1 FROM dbo.Jobs WHERE Status = 'Parts')
BEGIN
  DECLARE @migrating TABLE (JobID INT PRIMARY KEY);

  INSERT INTO @migrating (JobID)
  SELECT JobID FROM dbo.Jobs WHERE Status = 'Parts';

  UPDATE dbo.Jobs
  SET Status = 'Stalled',
      IsStalled = 1,
      StalledReason = 'Waiting on parts',
      LastModifiedDate = SYSUTCDATETIME()
  WHERE JobID IN (SELECT JobID FROM @migrating);

  INSERT INTO dbo.JobEvents (JobID, CreatedBy, [Text], EventType, NewStatus, IsStalled)
  SELECT JobID, 'system',
         'Migrated from Parts → Stalled (reason: Waiting on parts)',
         'status_changed', 'Stalled', 1
  FROM @migrating;
END
GO
