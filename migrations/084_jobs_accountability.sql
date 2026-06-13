-- Migration 084: Jobs-flow accountability & completion (WP18a).
-- Adds the four accountability columns the dashboard escalation/acknowledge
-- flow reads, all NULLABLE so existing rows backfill to NULL (no data fix):
--
--   AcknowledgedAt  — when the assignee last acknowledged the current state.
--   AcknowledgedBy  — display name of who acknowledged (identity.name).
--   EscalatedAt     — set once by the daily escalation evaluator so it fires a
--                     single manager email per overdue period; cleared on the
--                     next acknowledge / status transition (a fresh state needs
--                     fresh acknowledgement).
--   StatusSince     — when the job last entered its current status. Drives the
--                     escalation age clock via COALESCE(AcknowledgedAt,
--                     StatusSince, CreatedAt). NULL on legacy rows falls back to
--                     CreatedAt, so the evaluator still works without a backfill.
--
-- Escalation state lives on Jobs (not PlannerTasks) so the dashboard can read
-- it without coupling to Planner.
--
-- Re-runnable: IF NOT EXISTS per column, GO-separated (per 083's pattern).

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'AcknowledgedAt'
)
BEGIN
  ALTER TABLE dbo.Jobs ADD AcknowledgedAt DATETIME2 NULL;
  PRINT 'Added AcknowledgedAt column to dbo.Jobs';
END;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'AcknowledgedBy'
)
BEGIN
  ALTER TABLE dbo.Jobs ADD AcknowledgedBy NVARCHAR(200) NULL;
  PRINT 'Added AcknowledgedBy column to dbo.Jobs';
END;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'EscalatedAt'
)
BEGIN
  ALTER TABLE dbo.Jobs ADD EscalatedAt DATETIME2 NULL;
  PRINT 'Added EscalatedAt column to dbo.Jobs';
END;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'StatusSince'
)
BEGIN
  ALTER TABLE dbo.Jobs ADD StatusSince DATETIME2 NULL;
  PRINT 'Added StatusSince column to dbo.Jobs';
END;
GO
