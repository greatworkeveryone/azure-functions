-- 048_keys_lost_metadata.sql
--
-- Adds lost-event audit fields to dbo.Keys so the detail page can show
-- when a key was marked lost, by whom, and any comment captured at the time.
--
-- Mirrors the audit pattern from migration 047 (Created* / Deleted*).
-- Re-runnable.

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Keys') AND name = 'LostAt'
)
  ALTER TABLE dbo.Keys ADD LostAt DATETIME2 NULL;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Keys') AND name = 'LostById'
)
  ALTER TABLE dbo.Keys ADD LostById NVARCHAR(255) NULL;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Keys') AND name = 'LostByName'
)
  ALTER TABLE dbo.Keys ADD LostByName NVARCHAR(255) NULL;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Keys') AND name = 'LostComment'
)
  ALTER TABLE dbo.Keys ADD LostComment NVARCHAR(MAX) NULL;
GO
