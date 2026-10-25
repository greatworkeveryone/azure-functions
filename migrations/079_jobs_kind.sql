-- Migration 079: Add Kind column to Jobs.
-- Distinguishes reactive Facilities works from scheduled/recurring Maintenance
-- servicing. Both kinds share the same lifecycle, status machine and approval
-- gates — Kind only drives the board filter and a row chip.
--   facilities  — reactive, one-off works (tenant-reported / building issues).
--   maintenance — scheduled/recurring servicing (fire, HVAC, lifts, cleaning,
--                 compliance).
-- NOT NULL DEFAULT 'facilities' backfills every existing row as facilities,
-- matching the frontend's "treat missing as facilities" rule.
-- Kind changes emit a 'kind_change' JobEvent (Text only — no new event column).
--
-- Re-runnable.

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'Kind'
)
BEGIN
  ALTER TABLE dbo.Jobs
    ADD Kind NVARCHAR(50) NOT NULL CONSTRAINT DF_Jobs_Kind DEFAULT 'facilities';
  PRINT 'Added Kind column to dbo.Jobs';
END;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'IX_Jobs_Kind' AND object_id = OBJECT_ID('dbo.Jobs')
)
BEGIN
  CREATE NONCLUSTERED INDEX IX_Jobs_Kind ON dbo.Jobs (Kind)
    WHERE IsArchived = 0;
  PRINT 'Added IX_Jobs_Kind index';
END;
GO
