-- 054_scheduled_rate_steps.sql
-- Per-year fixed review rates for tenants whose review type uses a stepped
-- percentage schedule. Stored as a JSON array alongside Incentives.
-- Re-runnable (idempotent column add).

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Tenants')
    AND name = 'ScheduledRateSteps'
)
BEGIN
  ALTER TABLE dbo.Tenants ADD ScheduledRateSteps NVARCHAR(MAX) NULL;
  PRINT 'Added ScheduledRateSteps column to dbo.Tenants';
END;
GO
