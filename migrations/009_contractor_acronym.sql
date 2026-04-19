-- Migration 009: Contractor acronyms
--
-- Adds a 3-letter `Acronym` column to Contractors, used as the
-- {acronym} segment of PO / Quote numbers (YYMMDD-PO-{JobID}-{ACR}-{Seq}).
-- Lazily populated by the application on first PO/Quote create for a
-- contractor — no bulk backfill here, so re-running the migration is safe.
--
-- The unique filtered index enforces uniqueness only across populated
-- rows, so pre-existing NULL rows don't block the column-add on a busy DB.
--
-- Fully idempotent.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Contractors') AND name = 'Acronym')
  ALTER TABLE dbo.Contractors ADD Acronym NVARCHAR(3) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_Contractors_Acronym' AND object_id = OBJECT_ID('dbo.Contractors'))
  CREATE UNIQUE INDEX UX_Contractors_Acronym
    ON dbo.Contractors(Acronym)
    WHERE Acronym IS NOT NULL;
GO
