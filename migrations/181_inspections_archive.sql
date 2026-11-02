-- B2 (review 2026-10-30): inspections are archived, never deleted once relied on.
-- Additive and idempotent (column guards; safe to run twice). No destructive statement.
-- ArchivedAt/ArchivedById/ArchivedByName: set by deleteInspection when the inspection was ever completed,
--   has points or has raised jobs; archived rows are hidden from lists, kept for records.
-- FirstCompletedAt: stamped on reopen (and backfilled here) so a reopened draft still shows it was once completed.
-- Types match CompletedById / CompletedByName (m034).
IF COL_LENGTH(N'dbo.Inspections', N'ArchivedAt') IS NULL
  ALTER TABLE dbo.Inspections ADD ArchivedAt DATETIME2 NULL;
IF COL_LENGTH(N'dbo.Inspections', N'ArchivedById') IS NULL
  ALTER TABLE dbo.Inspections ADD ArchivedById NVARCHAR(200) NULL;
IF COL_LENGTH(N'dbo.Inspections', N'ArchivedByName') IS NULL
  ALTER TABLE dbo.Inspections ADD ArchivedByName NVARCHAR(200) NULL;
IF COL_LENGTH(N'dbo.Inspections', N'FirstCompletedAt') IS NULL
  ALTER TABLE dbo.Inspections ADD FirstCompletedAt DATETIME2 NULL;
GO

-- Backfill: fills NULLs only, so a second run changes nothing. Dynamic SQL because the columns
-- are added in this same batch group.
EXEC(N'UPDATE dbo.Inspections SET FirstCompletedAt = CompletedAt WHERE FirstCompletedAt IS NULL AND CompletedAt IS NOT NULL;');
PRINT CONCAT(N'181: FirstCompletedAt backfilled rows: ', @@ROWCOUNT);
