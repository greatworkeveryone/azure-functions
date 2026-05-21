-- Migration 071: Security deposit steps — per-period deposit tracking.
-- Stores a JSON array of { effectiveFrom, monthsRequired, actualHeld } entries
-- keyed by ScheduledRateStep.effectiveFrom. NULL until first save.
-- Old SecurityDepositRequired / SecurityDepositHeld remain for back-compat.

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Tenants')
    AND name = 'SecurityDepositSteps'
)
BEGIN
  ALTER TABLE dbo.Tenants ADD SecurityDepositSteps NVARCHAR(MAX) NULL;
  PRINT 'Added SecurityDepositSteps column to dbo.Tenants';
END;
GO
