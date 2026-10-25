-- Migration 095: CpiIndex source metadata (WP22).
--
-- The rebuilt ABS CPI sync (src/cpiAbs.ts + tenancyCpiSyncTimer) re-reads the
-- whole series from 2000-Q1 every day. ABS rebases the index from time to time
-- and restates every historical value when it does, so each stored value must
-- say which base it is expressed in. Rent-review maths reads two index values
-- from this table and must only ever compare values on the same base.
--
--   ReferenceBase  the ABS BASE_PERIOD label the IndexValue is on,
--                  e.g. 'Sep 2025 = 100.0' (a month, not a year)
--   SourceKey      the SDMX key within the dataflow, e.g. '1.10001.10.7.Q'
--                  (MEASURE.INDEX.TSEST.REGION.FREQ)
--   Dataflow       the dataflow and version served, e.g. 'CPI 2.0.0'
--
-- NULLable. dbo.CpiIndex has never been filled (the old sync could not match
-- the API), but a hand-keyed row must not fail this migration. NULL means
-- "base unknown"; the sync backfills it on its next run and readers must
-- treat it as not comparable.
--
-- Idempotent. The runner (src/migrate.ts) applies pending files at app start
-- in production and against the local Docker DB; each ALTER sits in its own
-- GO batch.

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.CpiIndex') AND name = 'ReferenceBase'
)
BEGIN
  ALTER TABLE dbo.CpiIndex ADD ReferenceBase NVARCHAR(50) NULL;
  PRINT 'Added ReferenceBase column to dbo.CpiIndex';
END;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.CpiIndex') AND name = 'SourceKey'
)
BEGIN
  ALTER TABLE dbo.CpiIndex ADD SourceKey NVARCHAR(100) NULL;
  PRINT 'Added SourceKey column to dbo.CpiIndex';
END;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.CpiIndex') AND name = 'Dataflow'
)
BEGIN
  ALTER TABLE dbo.CpiIndex ADD Dataflow NVARCHAR(50) NULL;
  PRINT 'Added Dataflow column to dbo.CpiIndex';
END;
GO
